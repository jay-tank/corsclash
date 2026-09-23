# Usage

## CLI

```sh
npx corsclash check src
npx corsclash check src/app.ts src/routes
```

Scans every `.ts`/`.tsx`/`.js`/`.mjs` file under the given paths
(skipping `node_modules`, `dist`, and dotfiles/dirs), reports a finding
per `cors({...})` config or raw header pair that combines a wildcard/
reflection origin with `credentials: true`, and exits `1` if any are
found — `0` otherwise. Designed to run in CI the same way a linter
does.

Example output:

```
src/app.ts:13  [cors-wildcard-credentials] cors() config combines origin: '*' with credentials: true — the Fetch/CORS spec forbids a wildcard Access-Control-Allow-Origin alongside Access-Control-Allow-Credentials: true, so browsers reject the response for any credentialed request

corsclash: found 1 invalid CORS credentials finding(s) across 1 file(s) scanned.
```

When nothing is found:

```
corsclash: scanned 2 cors() config(s) across 3 file(s), no wildcard/reflection + credentials combination found.
```

Finding kinds:

- `cors-wildcard-credentials` — `cors()` config with `origin: '*'` (or
  no `origin` key at all) and `credentials: true`.
- `cors-reflect-credentials` — `cors()` config with an origin callback
  that unconditionally reflects/allows any origin, and `credentials:
  true`.
- `header-wildcard-credentials` — the raw
  `res.setHeader("Access-Control-Allow-Origin", "*")` +
  `res.setHeader("Access-Control-Allow-Credentials", "true")` pair
  inside one handler.

## Library

```ts
import { analyzeSource, analyzeProject } from "corsclash";

const result = analyzeSource("app.ts", sourceText);
// result.findings: Finding[]
// result.configsScanned: number

const projectResult = analyzeProject([
  { fileName: "app.ts", text: "..." },
  { fileName: "routes.ts", text: "..." },
]);
```

`Finding` shape:

```ts
interface Finding {
  fileName: string;
  line: number;
  kind: "cors-wildcard-credentials" | "cors-reflect-credentials" | "header-wildcard-credentials";
  detail: string;
}
```

See [DETAILS.md](../DETAILS.md) for the full detection approach and
its documented limitations.
