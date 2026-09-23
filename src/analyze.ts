import ts from "typescript";

export interface Finding {
  fileName: string;
  line: number;
  kind: "cors-wildcard-credentials" | "cors-reflect-credentials" | "header-wildcard-credentials";
  detail: string;
}

export interface AnalyzeResult {
  findings: Finding[];
  configsScanned: number;
}

export interface SourceInput {
  fileName: string;
  text: string;
}

function lineOf(sourceFile: ts.SourceFile, node: ts.Node): number {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

/** Is this call expression a `cors(...)` invocation (bare or namespaced, e.g. `cors.default(...)`)? */
function isCorsCall(node: ts.CallExpression): boolean {
  const expr = node.expression;
  if (ts.isIdentifier(expr)) return expr.text === "cors";
  if (ts.isPropertyAccessExpression(expr)) return expr.name.text === "cors" || expr.name.text === "default";
  return false;
}

function findProperty(obj: ts.ObjectLiteralExpression, name: string): ts.PropertyAssignment | undefined {
  for (const prop of obj.properties) {
    if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name) && prop.name.text === name) {
      return prop;
    }
  }
  return undefined;
}

/** Is this expression the boolean literal `true`? */
function isTrueLiteral(expr: ts.Expression): boolean {
  return expr.kind === ts.SyntaxKind.TrueKeyword;
}

/** Is this expression the string literal `"*"`? */
function isWildcardStringLiteral(expr: ts.Expression): boolean {
  return ts.isStringLiteralLike(expr) && expr.text === "*";
}

/**
 * Does this function-like origin callback contain any conditional
 * structure (`if`, ternary, `&&`/`||` short-circuit, or an
 * allowlist-shaped call like `.includes(`/`.indexOf(`/`.some(`/`.test(`)
 * that could plausibly gate its decision on the incoming origin? A
 * conditional present anywhere is treated as "this looks like it
 * validates" — a deliberately generous heuristic that favors false
 * negatives (a badly-written conditional that still allows everything)
 * over false positives (flagging a real allowlist check).
 */
function looksLikeItValidates(fn: ts.Node): boolean {
  let found = false;
  function visit(node: ts.Node): void {
    if (found) return;
    if (
      ts.isIfStatement(node) ||
      ts.isConditionalExpression(node) ||
      (ts.isBinaryExpression(node) &&
        (node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
          node.operatorToken.kind === ts.SyntaxKind.BarBarToken))
    ) {
      found = true;
      return;
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ["includes", "indexOf", "some", "test", "has", "match"].includes(node.expression.name.text)
    ) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  }
  visit(fn);
  return found;
}

/**
 * Does this origin callback unconditionally call `callback(null, true)`
 * or `callback(null, <firstParamName>)` — i.e. reflect/allow whatever
 * origin it was given, with no gating logic anywhere in the body? This
 * is treated as equivalent-severity to a bare wildcard: it "works" for
 * every request, silently defeating CORS rather than breaking loudly.
 */
function isUnconditionalReflection(fn: ts.ArrowFunction | ts.FunctionExpression): boolean {
  if (looksLikeItValidates(fn)) return false;

  const params = fn.parameters;
  // Standard `cors` package origin-callback shape: (origin, callback) => ...
  const originParamName =
    params.length >= 1 && ts.isIdentifier(params[0].name) ? params[0].name.text : undefined;
  const callbackParamName =
    params.length >= 2 && ts.isIdentifier(params[1].name) ? params[1].name.text : undefined;
  if (!callbackParamName) return false;

  let sawUnconditionalReflect = false;

  function visit(node: ts.Node): void {
    if (sawUnconditionalReflect) return;
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === callbackParamName &&
      node.arguments.length >= 2
    ) {
      const secondArg = node.arguments[1];
      const isAllowTrue = isTrueLiteral(secondArg);
      const isReflectOrigin =
        originParamName !== undefined && ts.isIdentifier(secondArg) && secondArg.text === originParamName;
      if (isAllowTrue || isReflectOrigin) {
        sawUnconditionalReflect = true;
        return;
      }
    }
    ts.forEachChild(node, visit);
  }

  if (fn.body) visit(fn.body);
  return sawUnconditionalReflect;
}

/**
 * Classifies a `cors({...})` config object's `origin` property.
 * Returns "wildcard" for a bare `'*'` string or an entirely absent
 * `origin` key (the `cors` package's own documented default is `*`),
 * "reflect" for an origin-callback function that unconditionally
 * allows/reflects whatever it's given, or undefined if the origin
 * looks like a genuine allowlist (string, array, or a validating
 * callback) and this check has nothing to say about it.
 */
function classifyOrigin(
  originProp: ts.PropertyAssignment | undefined
): "wildcard" | "reflect" | undefined {
  if (!originProp) return "wildcard"; // no origin key at all -> defaults to '*'
  const value = originProp.initializer;
  if (isWildcardStringLiteral(value)) return "wildcard";
  if (
    (ts.isArrowFunction(value) || ts.isFunctionExpression(value)) &&
    isUnconditionalReflection(value)
  ) {
    return "reflect";
  }
  return undefined;
}

function analyzeCorsCall(node: ts.CallExpression, sourceFile: ts.SourceFile, fileName: string): Finding | undefined {
  const [arg] = node.arguments;
  if (!arg || !ts.isObjectLiteralExpression(arg)) return undefined;

  const originProp = findProperty(arg, "origin");
  const credentialsProp = findProperty(arg, "credentials");
  if (!credentialsProp || !isTrueLiteral(credentialsProp.initializer)) return undefined;

  const originKind = classifyOrigin(originProp);
  if (!originKind) return undefined;

  const line = lineOf(sourceFile, node);
  if (originKind === "wildcard") {
    const originDetail = originProp
      ? "origin: '*'"
      : "no `origin` key at all (the cors package defaults to '*')";
    return {
      fileName,
      line,
      kind: "cors-wildcard-credentials",
      detail: `cors() config combines ${originDetail} with credentials: true — the Fetch/CORS spec forbids a wildcard Access-Control-Allow-Origin alongside Access-Control-Allow-Credentials: true, so browsers reject the response for any credentialed request`,
    };
  }
  return {
    fileName,
    line,
    kind: "cors-reflect-credentials",
    detail:
      "cors() origin callback unconditionally reflects/allows whatever Origin header it receives (no allowlist check anywhere in the callback) while credentials: true is set — this is equivalent-severity to a wildcard, but more dangerous: it silently succeeds for every origin instead of breaking loudly, defeating CORS entirely",
  };
}

/** Is this a `res.setHeader('Access-Control-Allow-Origin', '*')`-shaped call? */
function matchSetHeaderCall(
  node: ts.CallExpression
): { headerName: string; value: string } | undefined {
  const expr = node.expression;
  if (!ts.isPropertyAccessExpression(expr) || expr.name.text !== "setHeader") return undefined;
  const [nameArg, valueArg] = node.arguments;
  if (!nameArg || !valueArg || !ts.isStringLiteralLike(nameArg) || !ts.isStringLiteralLike(valueArg)) {
    return undefined;
  }
  return { headerName: nameArg.text, value: valueArg.text };
}

/**
 * Within one function body, finds a raw
 * `res.setHeader('Access-Control-Allow-Origin', '*')` paired with
 * `res.setHeader('Access-Control-Allow-Credentials', 'true')` — the
 * hand-rolled equivalent of the `cors()` gap, for codebases that set
 * CORS headers directly instead of using the `cors` middleware.
 */
function findRawHeaderFindings(fn: ts.Node, sourceFile: ts.SourceFile, fileName: string): Finding[] {
  let originCall: ts.CallExpression | undefined;
  let credentialsCall: ts.CallExpression | undefined;

  function visit(node: ts.Node): void {
    // Don't descend into a nested function's own body — its header
    // calls belong to that inner handler, scanned separately when
    // traversal reaches it, not to this outer one.
    if (node !== fn && isFunctionLike(node)) return;
    if (ts.isCallExpression(node)) {
      const match = matchSetHeaderCall(node);
      if (match) {
        if (match.headerName === "Access-Control-Allow-Origin" && match.value === "*") {
          originCall = node;
        } else if (
          match.headerName === "Access-Control-Allow-Credentials" &&
          match.value.toLowerCase() === "true"
        ) {
          credentialsCall = node;
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(fn);

  if (originCall && credentialsCall) {
    return [
      {
        fileName,
        line: lineOf(sourceFile, originCall),
        kind: "header-wildcard-credentials",
        detail:
          "handler sets Access-Control-Allow-Origin: '*' and Access-Control-Allow-Credentials: true in the same function — the same forbidden wildcard+credentials combination as cors({origin: '*', credentials: true}), just written by hand instead of through the cors package",
      },
    ];
  }
  return [];
}

function isFunctionLike(node: ts.Node): node is ts.FunctionLikeDeclaration {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node)
  );
}

export function analyzeSource(fileName: string, text: string): AnalyzeResult {
  const sourceFile = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const findings: Finding[] = [];
  let configsScanned = 0;

  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node) && isCorsCall(node)) {
      configsScanned++;
      const finding = analyzeCorsCall(node, sourceFile, fileName);
      if (finding) findings.push(finding);
    }
    if (isFunctionLike(node) && node.body) {
      findings.push(...findRawHeaderFindings(node.body, sourceFile, fileName));
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return { findings, configsScanned };
}

export function analyzeProject(sources: SourceInput[]): AnalyzeResult {
  const findings: Finding[] = [];
  let configsScanned = 0;
  for (const s of sources) {
    const r = analyzeSource(s.fileName, s.text);
    findings.push(...r.findings);
    configsScanned += r.configsScanned;
  }
  return { findings, configsScanned };
}
