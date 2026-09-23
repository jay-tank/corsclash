#!/usr/bin/env node
import { readFileSync, statSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { analyzeProject } from "./analyze.js";

function collectFiles(patterns: string[]): string[] {
  const results: string[] = [];
  for (const pattern of patterns) {
    walk(pattern, results);
  }
  return results;
}

function walk(path: string, results: string[]): void {
  let stat;
  try {
    stat = statSync(path);
  } catch {
    return;
  }
  if (stat.isDirectory()) {
    for (const entry of readdirSync(path)) {
      if (entry === "node_modules" || entry === "dist" || entry.startsWith(".")) continue;
      walk(`${path}/${entry}`, results);
    }
  } else if (
    stat.isFile() &&
    (path.endsWith(".ts") || path.endsWith(".tsx") || path.endsWith(".js") || path.endsWith(".mjs")) &&
    !path.endsWith(".d.ts")
  ) {
    results.push(path);
  }
}

function main(): void {
  const args = process.argv.slice(2);
  const command = args[0];

  if (command !== "check" || args.length < 2) {
    console.error("Usage: corsclash check <file-or-dir> [more files/dirs...]");
    process.exit(2);
  }

  const targets = args.slice(1);
  const files = collectFiles(targets);

  if (files.length === 0) {
    console.error("corsclash: no source files found in the given paths");
    process.exit(2);
  }

  const sources = files.map((f) => ({ fileName: resolve(f), text: readFileSync(f, "utf8") }));
  const result = analyzeProject(sources);

  if (result.findings.length === 0) {
    console.log(
      `corsclash: scanned ${result.configsScanned} cors() config(s) across ${files.length} file(s), no wildcard/reflection + credentials combination found.`
    );
    process.exit(0);
  }

  for (const f of result.findings) {
    console.log(`${f.fileName}:${f.line}  [${f.kind}] ${f.detail}`);
  }

  console.log(
    `\ncorsclash: found ${result.findings.length} invalid CORS credentials finding(s) across ${files.length} file(s) scanned.`
  );
  process.exit(1);
}

main();
