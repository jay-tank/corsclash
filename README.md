# corsclash

Static analyzer CLI that flags an Express `cors()` config (from the
`cors` npm package) — or the raw `Access-Control-Allow-*` header
equivalent — that combines **`origin: '*'`** (or an **omitted `origin`
key**, which the `cors` package itself defaults to `'*'`) with
**`credentials: true`**.

```ts
// Looks reasonable at a glance. Works fine for every plain GET from a
// browser with no cookies/Authorization header involved. The day a
// credentialed request (`credentials: 'include'` on the client) hits
// this endpoint, the browser silently rejects the response — per the
// Fetch/CORS spec, Access-Control-Allow-Origin: * can never be paired
// with Access-Control-Allow-Credentials: true. No server-side error,
// no log line — just a CORS error in the browser console that looks
// like a config mistake on the *client*.
app.use(cors({ origin: "*", credentials: true }));
```

`corsclash` also treats an origin **reflection callback** —
`origin: (origin, callback) => callback(null, true)` or
`callback(null, origin)`, with no allowlist check anywhere in the
function — as equivalent-severity to the wildcard case, and explains
in [DETAILS.md](./DETAILS.md) why it's actually the more dangerous
version of this gap.

See [DETAILS.md](./DETAILS.md) for the full gap analysis, the
heuristic used to tell "validates" from "unconditionally reflects,"
and an honest list of what it can't see.

## Install

```bash
npm install -g corsclash
```

## Usage

```bash
npx corsclash check src
npx corsclash check src/app.ts
```

Example output:

```
src/app.ts:13  [cors-wildcard-credentials] cors() config combines origin: '*' with credentials: true — the Fetch/CORS spec forbids a wildcard Access-Control-Allow-Origin alongside Access-Control-Allow-Credentials: true, so browsers reject the response for any credentialed request

corsclash: found 1 invalid CORS credentials finding(s) across 1 file(s) scanned.
```

Exit codes: `0` clean, `1` a finding was reported, `2` usage error.
Full flag/output reference in [docs/USAGE.md](docs/USAGE.md).

## What it detects

- `cors({ origin: "*", credentials: true })` — an explicit wildcard.
- `cors({ credentials: true })` with **no `origin` key at all** — the
  `cors` package's own documented default is `'*'`, so this is the
  same gap spelled differently.
- `cors({ origin: (origin, callback) => callback(null, true), credentials: true })`
  and the `callback(null, origin)` variant — an origin callback that
  unconditionally allows/reflects whatever it's given, with no
  conditional or allowlist check anywhere in its body.
- The hand-rolled equivalent: `res.setHeader("Access-Control-Allow-Origin", "*")`
  paired with `res.setHeader("Access-Control-Allow-Credentials", "true")`
  inside the same handler/middleware function.

It does **not** flag:

- A real, specific origin string/array paired with `credentials: true`
  — that's exactly the fix the CORS spec's wildcard restriction is
  meant to push developers toward.
- `origin: "*"` with no `credentials` key at all — wildcard-only is a
  legitimate, common, and safe shape for a fully public,
  unauthenticated API.
- A dynamic `origin` callback that gates its decision on an allowlist
  check (`.includes(`, `.indexOf(`, an `if`, a ternary, ...) — see
  DETAILS.md for the exact heuristic and its trade-offs.

Parsing is done directly with the TypeScript Compiler API, so
`corsclash` understands real TypeScript/JavaScript syntax rather than
regexing source text — it never executes the code it scans.

## What this is not

- Not a general CORS linter — it doesn't validate every `cors()`
  option (`methods`, `allowedHeaders`, `exposedHeaders`, `maxAge`,
  ...), only the specific wildcard/reflection-vs-credentials
  contradiction.
- Not a runtime/observability tool — it never imports, requires, or
  executes the scanned code; everything is read as source text.
- Not a semantic verifier of a custom origin-validation function — it
  can tell "there's a conditional here" from "there's no conditional
  at all," not whether that conditional is actually correct. See
  DETAILS.md's limitations section.

## License

MIT © 2026 Jay
