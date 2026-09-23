# corsclash — Design Details

## The gap this fills

`cors({ origin: "*", credentials: true })` reads like "allow everyone,
and also support cookies/auth for everyone" — a plausible-sounding pair
of requirements that turn out to be contradictory by design. Per the
Fetch standard (which the CORS spec defers to) and every current
browser's implementation of it: when a request is made with
credentials (`fetch(url, { credentials: "include" })`, or any
`XMLHttpRequest` with `withCredentials = true`), the browser refuses to
expose the response to the calling script unless
`Access-Control-Allow-Origin` names the exact requesting origin — a
literal `*` is explicitly disallowed in that case, and
`Access-Control-Allow-Credentials: true` on top of a wildcard origin
does not change that; the combination is simply invalid and the
browser drops the response silently from the page's point of view.

The `cors` npm package (the de facto standard Express CORS
middleware) does not stop you from configuring this. Passing
`{ origin: "*", credentials: true }` sets both headers exactly as
asked, because at the server layer there's nothing syntactically wrong
with sending both headers — the contradiction only bites in the
browser, on the credentialed request path.

The insidious part: **it half-works.** Every plain `fetch()`/curl
request with no cookies/Authorization header involved gets a perfectly
valid response and reads it fine — because the browser only enforces
the wildcard-vs-credentials restriction on the credentialed path.
Manual testing, most integration tests, and a curl-based smoke check
all pass. The gap only shows up the moment a real browser client sends
a credentialed request, and even then it doesn't show up as a server
error: the request often still shows a `200` in the Network tab (the
server responded fine) while the browser's console prints a CORS error
and the calling JavaScript never sees the response body. That's a
confusing failure mode to debug from either side — it looks like a
client bug from the server's logs, and a server bug from the browser
console.

## Omitted `origin` is the same gap, just quieter

`cors()`'s own documented default for `origin` — when the option is
left out of the config object entirely — is `*`. A config that's
strictly `cors({ credentials: true })` with no `origin` key visible
anywhere is functionally identical to writing `origin: "*"` explicitly;
it's just easier to miss in review because there's no literal `'*'`
string to grep for. `corsclash` treats an entirely-absent `origin` key
the same as an explicit wildcard for exactly this reason — see
`classifyOrigin` in `src/analyze.ts`, which returns `"wildcard"` both
when `origin: "*"` is written and when the `origin` property is missing
from the object literal altogether.

## The reflection callback — the more dangerous version of this gap

Once a team hits the wildcard+credentials browser error above, a common
next move is to make `origin` "dynamic" so it isn't a literal `*`
anymore — reasoning that a function must be doing something smarter
than a hardcoded string. The `cors` package's own documented API for
this is an `origin` function of shape `(origin, callback) => ...`,
where `origin` is the requesting `Origin` header's value and calling
`callback(null, true)` tells `cors` "yes, allow this one; echo it back
as the `Access-Control-Allow-Origin` value" (the package handles the
header-value mechanics — whatever origin was requested gets reflected
back verbatim once `callback(null, true)` is called).

The bug: if that callback unconditionally calls `callback(null, true)`
(or the equivalent `callback(null, origin)`, explicitly reflecting
whatever origin string it was handed) with **no check on `origin` at
all**, the config now passes the "not a literal wildcard" test a naive
linter or code reviewer might apply, while being **functionally
identical to a wildcard** from a security standpoint — except now it
also satisfies the browser's same-exact-origin requirement, because
each request gets back its own origin, individually, as if it were on
an allowlist.

This is why the README and this tool treat it as **equivalent-severity
to the wildcard case, but actually the more dangerous variant**:

- The wildcard version (`origin: "*", credentials: true`) **breaks
  loudly** — every credentialed request visibly fails in the browser
  console, which tends to get noticed and fixed relatively quickly
  because something is obviously broken.
- The reflection version **works for every single origin, silently**.
  There is no broken credentialed request to notice — `https://
  evil.example` gets exactly the same "yes, you're allowed, with
  credentials" treatment as the legitimate frontend does. CORS is not
  half-broken here; it is completely defeated, and it looks, from the
  outside, like a correctly configured allowlist.

```ts
// Looks like a real allowlist function. Isn't one — nothing here ever
// reads `origin` to decide anything; every single request gets the
// same answer.
app.use(cors({
  origin: (origin, callback) => callback(null, true),
  credentials: true,
}));
```

## The heuristic: "validates" vs. "unconditionally reflects"

`corsclash` cannot execute the callback to see what it actually does
with a given `origin` value at runtime — same "read as source text,
never execute" constraint every static analyzer in this workspace
operates under. The heuristic it uses instead
(`looksLikeItValidates`/`isUnconditionalReflection` in
`src/analyze.ts`):

1. Walk the origin callback's body looking for **any** conditional
   structure: an `if` statement, a ternary (`? :`), a `&&`/`||`
   short-circuit, or a call to `.includes(`/`.indexOf(`/`.some(`/
   `.test(`/`.has(`/`.match(` on any receiver. If **any** of these
   appear anywhere in the function body, the callback is treated as
   "looks like it validates" and is never flagged — deliberately
   generous, favoring a false negative (a badly-written conditional
   that still ends up allowing everything) over a false positive
   (flagging a genuine allowlist check).
2. If no such structure exists anywhere in the body, and the function
   matches the `cors` package's documented `(origin, callback) => ...`
   two-parameter shape, walk it for a call to the second parameter
   (the callback) with a second argument that is either the literal
   `true` or the same identifier as the first parameter (`origin`
   reflected back verbatim). Either shape, found with zero surrounding
   conditionals, is flagged as `cors-reflect-credentials`.

This is a **syntactic** heuristic, not a semantic one — it cannot tell
a real allowlist check from a conditional that's structurally present
but practically meaningless (e.g. `if (true) { callback(null, true); }`
would be treated as "validates" and not flagged, since the `if` is
there even though it decides nothing). That trade-off was deliberate:
the alternative — trying to evaluate whether a conditional's *result*
is meaningful — requires real data-flow/constant-folding analysis, well
past what a syntax-tree pattern match can responsibly claim to do
without producing its own wrong answers.

## Verified facts (September 2026)

- **Fetch/CORS wildcard-vs-credentials restriction**: confirmed against
  the WHATWG Fetch standard's CORS protocol section and the `cors`
  npm package's own README, which documents `credentials: true`
  requiring a non-wildcard `origin` to have any real effect in
  browsers, and separately documents the `origin` function's
  `callback(err, allow)` signature and its origin-reflection behavior
  when `allow` is `true`.
- **`cors` package default**: confirmed against its README — `origin`
  defaults to `*` when the option is omitted from the config object.
- A search for existing static-analysis tooling in this space (September
  2026) turned up generic security linters (`eslint-plugin-security`
  and similar) that don't inspect `cors()` call sites at all, and
  various blog posts explaining the wildcard+credentials browser error
  after a developer already hit it in production — no dedicated static
  checker was found that (a) recognizes the `cors({...})` call-site
  shape directly, (b) treats an omitted `origin` key as equivalent to
  an explicit wildcard, and (c) also flags the dynamic-reflection
  callback pattern as an equivalent-severity variant. `corsclash` is
  that check.

## Detection approach (`src/analyze.ts`)

Uses the TypeScript Compiler API directly (`ts.createSourceFile` +
`ts.forEachChild` traversal) — the same choice this workspace's other
Node siblings (`asyncdrop`, `rowflood`) make, for the same reasons: no
extra dependency beyond `typescript`, and a syntax tree that's already
exactly what a syntax-only pattern match needs.

For every call expression:

1. Recognize a `cors(...)` call: a bare `cors(...)` identifier call, or
   a property-access call whose accessed name is `cors` or `default`
   (covering both `import cors from "cors"` and a namespaced
   `import * as cors from "cors"; cors.default(...)` import shape).
2. If its single argument is an object literal, look for `origin` and
   `credentials` properties by name.
3. `credentials` must be the literal `true` — a computed/non-literal
   value (e.g. `credentials: process.env.ALLOW_CREDS === "1"`) isn't
   confidently `true` at analysis time and is left unflagged rather
   than guessed at.
4. Classify `origin` (`classifyOrigin`): `"wildcard"` if the property is
   missing entirely or is the string literal `"*"`; `"reflect"` if it's
   an arrow/function expression that `isUnconditionalReflection`
   identifies as described above; otherwise `undefined` (a real
   string, array, or validating callback — nothing to flag).
5. A `"wildcard"` or `"reflect"` classification alongside
   `credentials: true` produces a `cors-wildcard-credentials` or
   `cors-reflect-credentials` finding respectively.

Independently, for every function-like node (function declaration,
function expression, arrow function, method), its body (not descending
into any nested function's own body — mirroring `asyncdrop`'s
`hasUnguardedAwait` scoping, so a header call in a different, unrelated
handler is never attributed to this one) is scanned for a
`res.setHeader("Access-Control-Allow-Origin", "*")` call paired with a
`res.setHeader("Access-Control-Allow-Credentials", "true")` call within
that same function — the raw, hand-rolled equivalent of the `cors()`
gap, for codebases that set headers directly instead of using the
middleware.

## Honest limitations (non-goals / false positives / false negatives)

This is syntax-only AST pattern matching, **not** type-checked or
data-flow analysis. Concretely:

- **False negatives:**
  - A `cors()` config built up across multiple statements (e.g.
    `const opts = {}; opts.origin = "*"; opts.credentials = true; app.use(cors(opts));`)
    is not traced — `corsclash` only inspects an object literal written
    directly as the call's argument. Tracing an identifier back through
    assignments/spreads is real data-flow analysis, out of scope for
    v0.1.
  - A conditional that exists syntactically but decides nothing
    meaningful (`if (true)`, `if (Math.random() > -1)`) is treated as
    "validates" and not flagged — see the heuristic section above.
  - `credentials` set through a non-literal expression that always
    evaluates to `true` at runtime (a constant imported from another
    module, an env var default) is not resolved to `true` and is left
    unflagged.
  - A raw-header pattern spread across a middleware chain (one
    middleware sets the origin header, a *different* middleware
    further down the chain sets the credentials header) is not
    detected — the check is scoped to a single function body,
    deliberately, since correlating separate middleware functions
    reliably would require call-graph analysis this tool doesn't do.
- **False positives:**
  - A `someOtherLibrary.cors({...})` call on an unrelated object that
    happens to have a `cors` method is still matched by the
    property-access shape — full type information would resolve
    whether that receiver is actually the `cors` npm package's export;
    syntax-only pattern matching cannot. This mirrors the same
    trade-off `asyncdrop` makes for its `app`/`router` receiver-name
    heuristic.
  - An origin callback with an `if`/ternary/allowlist-shaped call that
    is itself vacuous (see above) is treated as validating and not
    flagged, even though it's functionally identical to a bare
    reflection.

If precision matters more than recall for a given codebase, treat
`corsclash`'s findings as a starting list to confirm manually against
each config's real intent, not an infallible verdict — the same fast,
dependency-light, AST-heuristic trade-off this workspace's other static
analyzers make versus a full type-checked data-flow analysis.

## Build

Mirrors `asyncdrop`'s tsup setup exactly: dual ESM (`dist/index.js`) +
CJS (`dist/index.cjs`) output via tsup, with type declarations
generated by a separate `tsc --emitDeclarationOnly` pass (tsup's own
`dts` bundling turned off) and `dist/index.d.cts` copied from
`dist/index.d.ts` so both module systems get typed. The CLI
(`src/cli.ts`) is a second tsup entry point, shipped as the `corsclash`
bin in `.cjs` form for maximum compatibility with `require`-based
global installs. `typescript` is a `dependencies` entry (not just a dev
dependency), since the target codebase's source is parsed at analysis
time with the same package this tool ships with, pinned to `^5.9.3`.
