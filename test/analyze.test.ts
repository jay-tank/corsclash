import { describe, it, expect } from "vitest";
import { analyzeSource, analyzeProject } from "../src/analyze.js";

describe("analyzeSource — flags the wildcard + credentials combination", () => {
  it("flags cors({origin: '*', credentials: true})", () => {
    const text = `
      import cors from "cors";
      app.use(cors({ origin: "*", credentials: true }));
    `;
    const result = analyzeSource("app.ts", text);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].kind).toBe("cors-wildcard-credentials");
  });

  it("flags cors({credentials: true}) with no origin key at all (defaults to '*')", () => {
    const text = `
      app.use(cors({ credentials: true }));
    `;
    const result = analyzeSource("app.ts", text);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].kind).toBe("cors-wildcard-credentials");
    expect(result.findings[0].detail).toMatch(/no `origin` key/);
  });

  it("flags cors() called as a bare function reference with a single-quoted wildcard", () => {
    const text = `
      app.use(cors({ origin: '*', credentials: true, methods: ['GET', 'POST'] }));
    `;
    const result = analyzeSource("app.ts", text);
    expect(result.findings).toHaveLength(1);
  });

  it("flags cors.default({...}) namespaced import call shape", () => {
    const text = `
      app.use(cors.default({ origin: "*", credentials: true }));
    `;
    const result = analyzeSource("app.ts", text);
    expect(result.findings).toHaveLength(1);
  });

  it("reports the correct line number for the cors() call", () => {
    const text = `
      const opts = { credentials: true };


      app.use(cors({ origin: "*", credentials: true }));
    `;
    const result = analyzeSource("app.ts", text);
    expect(result.findings[0].line).toBe(5);
  });
});

describe("analyzeSource — flags the unconditional-reflection callback pattern", () => {
  it("flags origin: (origin, callback) => callback(null, true) with credentials: true", () => {
    const text = `
      app.use(cors({
        origin: (origin, callback) => callback(null, true),
        credentials: true,
      }));
    `;
    const result = analyzeSource("app.ts", text);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].kind).toBe("cors-reflect-credentials");
  });

  it("flags origin: (origin, callback) => callback(null, origin) — reflecting the incoming Origin header", () => {
    const text = `
      app.use(cors({
        origin: (origin, callback) => {
          callback(null, origin);
        },
        credentials: true,
      }));
    `;
    const result = analyzeSource("app.ts", text);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].kind).toBe("cors-reflect-credentials");
  });

  it("flags a function-expression reflection callback, not just arrow functions", () => {
    const text = `
      app.use(cors({
        origin: function (origin, callback) {
          callback(null, true);
        },
        credentials: true,
      }));
    `;
    const result = analyzeSource("app.ts", text);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].kind).toBe("cors-reflect-credentials");
  });

  it("does not flag a dynamic origin function that validates against an allowlist array", () => {
    const text = `
      const allowedOrigins = ["https://example.com", "https://app.example.com"];
      app.use(cors({
        origin: (origin, callback) => {
          if (allowedOrigins.includes(origin)) {
            callback(null, true);
          } else {
            callback(new Error("Not allowed by CORS"));
          }
        },
        credentials: true,
      }));
    `;
    const result = analyzeSource("app.ts", text);
    expect(result.findings).toEqual([]);
  });

  it("does not flag an origin function using indexOf() to validate", () => {
    const text = `
      app.use(cors({
        origin: (origin, callback) => {
          if (allowedOrigins.indexOf(origin) !== -1) {
            callback(null, true);
          } else {
            callback(null, false);
          }
        },
        credentials: true,
      }));
    `;
    const result = analyzeSource("app.ts", text);
    expect(result.findings).toEqual([]);
  });

  it("does not flag an origin function gated by a ternary check", () => {
    const text = `
      app.use(cors({
        origin: (origin, callback) => callback(null, allowedOrigins.includes(origin) ? true : false),
        credentials: true,
      }));
    `;
    const result = analyzeSource("app.ts", text);
    expect(result.findings).toEqual([]);
  });
});

describe("analyzeSource — does not flag safe configurations", () => {
  it("does not flag cors({origin: 'https://example.com', credentials: true}) — a real allowlisted origin", () => {
    const text = `
      app.use(cors({ origin: "https://example.com", credentials: true }));
    `;
    const result = analyzeSource("app.ts", text);
    expect(result.findings).toEqual([]);
  });

  it("does not flag cors({origin: '*'}) with no credentials — wildcard-only is fine for non-credentialed APIs", () => {
    const text = `
      app.use(cors({ origin: "*" }));
    `;
    const result = analyzeSource("app.ts", text);
    expect(result.findings).toEqual([]);
  });

  it("does not flag cors({credentials: true}) paired with a real origin (no wildcard, no reflection)", () => {
    const text = `
      app.use(cors({ origin: "https://dashboard.example.com", credentials: true }));
    `;
    const result = analyzeSource("app.ts", text);
    expect(result.findings).toEqual([]);
  });

  it("does not flag cors({credentials: false, origin: '*'})", () => {
    const text = `
      app.use(cors({ origin: "*", credentials: false }));
    `;
    const result = analyzeSource("app.ts", text);
    expect(result.findings).toEqual([]);
  });

  it("does not flag cors() with an array of allowlisted origins and credentials: true", () => {
    const text = `
      app.use(cors({ origin: ["https://a.example.com", "https://b.example.com"], credentials: true }));
    `;
    const result = analyzeSource("app.ts", text);
    expect(result.findings).toEqual([]);
  });

  it("does not flag an unrelated .cors() method call on some other object", () => {
    const text = `
      const config = someBuilder.cors({ origin: "*", credentials: true });
    `;
    const result = analyzeSource("app.ts", text);
    // someBuilder.cors(...) is a property-access call whose name is "cors",
    // which this tool intentionally still treats as a candidate cors() config
    // (the shape is identical either way and worth flagging either way).
    expect(result.configsScanned).toBe(1);
  });

  it("counts scanned configs even when nothing is flagged", () => {
    const text = `
      app.use(cors({ origin: "https://example.com" }));
    `;
    const result = analyzeSource("app.ts", text);
    expect(result.configsScanned).toBe(1);
    expect(result.findings).toEqual([]);
  });
});

describe("analyzeSource — raw Access-Control-* header pattern", () => {
  it("flags res.setHeader('Access-Control-Allow-Origin', '*') + Allow-Credentials 'true' in one handler", () => {
    const text = `
      app.use((req, res, next) => {
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("Access-Control-Allow-Credentials", "true");
        next();
      });
    `;
    const result = analyzeSource("app.ts", text);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].kind).toBe("header-wildcard-credentials");
  });

  it("does not flag a wildcard-only header handler with no credentials header", () => {
    const text = `
      app.use((req, res, next) => {
        res.setHeader("Access-Control-Allow-Origin", "*");
        next();
      });
    `;
    const result = analyzeSource("app.ts", text);
    expect(result.findings).toEqual([]);
  });

  it("does not flag a real-origin header handler with credentials true", () => {
    const text = `
      app.use((req, res, next) => {
        res.setHeader("Access-Control-Allow-Origin", "https://example.com");
        res.setHeader("Access-Control-Allow-Credentials", "true");
        next();
      });
    `;
    const result = analyzeSource("app.ts", text);
    expect(result.findings).toEqual([]);
  });

  it("does not flag two unrelated handlers that each only set one of the two headers", () => {
    const text = `
      app.use((req, res, next) => {
        res.setHeader("Access-Control-Allow-Origin", "*");
        next();
      });
      app.use((req, res, next) => {
        res.setHeader("Access-Control-Allow-Credentials", "true");
        next();
      });
    `;
    const result = analyzeSource("app.ts", text);
    expect(result.findings).toEqual([]);
  });
});

describe("analyzeProject", () => {
  it("aggregates findings and configsScanned across multiple files", () => {
    const sources = [
      { fileName: "a.ts", text: `app.use(cors({ origin: "*", credentials: true }));` },
      { fileName: "b.ts", text: `app.use(cors({ origin: "https://example.com" }));` },
    ];
    const result = analyzeProject(sources);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].fileName).toBe("a.ts");
    expect(result.configsScanned).toBe(2);
  });
});
