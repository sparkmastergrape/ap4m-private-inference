/**
 * The import boundary, enforced. DESIGN/xrplh-18 section 3.
 *
 *   hack/ap4m  may import  hack/ap4m/vendor and npm deps only.
 *   hack/ap4m  reaches services/* by HTTP, never by import.
 *   services/* must never mention hack/ at all.
 *
 * Run from hack/ap4m: node scripts/check-boundaries.mjs
 * Exit 0 = clean, 1 = a violation (printed with file and line).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const here = resolve(import.meta.dirname, "..");
const repo = resolve(here, "..", "..");
const SKIP = new Set(["node_modules", ".git", "vendor", "dist", "data", "generated"]);
const CODE = /\.(ts|mts|cts|js|mjs|cjs)$/;

/** import/export ... from "X", require("X"), and dynamic import("X"). */
const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)["']([^"']+)["']/g;

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (CODE.test(name)) out.push(path);
  }
  return out;
}

const problems = [];

function check(files, test, message) {
  for (const file of files) {
    const lines = readFileSync(file, "utf8").split(/\r?\n/);
    lines.forEach((line, i) => {
      for (const m of line.matchAll(SPECIFIER)) {
        if (test(m[1])) problems.push(`${relative(repo, file)}:${i + 1}  ${message}\n    ${line.trim()}`);
      }
    });
  }
}

// hack/ap4m must not import anything from services/.
check(walk(here), (spec) => /(^|\/)services\//.test(spec), "imports services/ — use HTTP instead");

// services/ must not reference hack/ in any direction.
let serviceFiles = [];
try {
  serviceFiles = walk(join(repo, "services"));
} catch {
  // no services/ tree here; nothing to check
}
check(serviceFiles, (spec) => /(^|\/)hack\//.test(spec), "references hack/ — services must not depend on hackathon code");

if (problems.length) {
  console.error(`boundary check failed (${problems.length} problem${problems.length === 1 ? "" : "s"}):\n`);
  for (const p of problems) console.error(p + "\n");
  process.exit(1);
}
console.log("boundary check passed: hack/ap4m imports no services/, services/ references no hack/");
