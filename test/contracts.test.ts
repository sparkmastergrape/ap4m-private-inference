import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

type Schema = { type?: string; required?: string[]; properties?: Record<string, Schema>; example?: unknown };

/** A deliberately small checker: type, required keys, and property types. */
function problems(schema: Schema, value: unknown, path = "$"): string[] {
  const kind = Array.isArray(value) ? "array" : value === null ? "null" : typeof value;
  const want = schema.type === "integer" ? "number" : schema.type;
  if (want && kind !== want) return [`${path}: expected ${schema.type}, got ${kind}`];
  if (schema.type === "integer" && !Number.isInteger(value)) return [`${path}: expected an integer`];
  const out: string[] = [];
  if (kind === "object") {
    for (const key of schema.required ?? []) if (!(key in (value as object))) out.push(`${path}.${key}: required`);
    for (const [key, sub] of Object.entries(schema.properties ?? {})) {
      if (key in (value as object)) out.push(...problems(sub, (value as Record<string, unknown>)[key], `${path}.${key}`));
    }
  }
  return out;
}

const dir = new URL("../contracts/", import.meta.url).pathname.replace(/^\/(\w:)/, "$1");
const files = readdirSync(dir).filter((f) => f.endsWith(".json"));

test("there is a contract for each service this package calls", () => {
  assert.deepEqual(files.sort(), ["client-privacy.json", "gateway.json", "merchant.json"]);
});

for (const file of files) {
  const contract = JSON.parse(readFileSync(join(dir, file), "utf8")) as { endpoints: Record<string, { request?: Schema; response?: Schema }> };
  for (const [name, endpoint] of Object.entries(contract.endpoints)) {
    for (const side of ["request", "response"] as const) {
      const schema = endpoint[side];
      if (!schema) continue;
      test(`${file} ${name} ${side}: the captured example satisfies its own schema`, () => {
        assert.ok(schema.example !== undefined, "every schema carries an example");
        assert.deepEqual(problems(schema, schema.example), []);
      });
      test(`${file} ${name} ${side}: a missing required key is caught`, () => {
        const key = schema.required?.[0];
        if (!key) return;
        const broken = { ...(schema.example as Record<string, unknown>) };
        delete broken[key];
        assert.ok(problems(schema, broken).length > 0);
      });
    }
  }
}

test("masked output never carries a value the example map holds", () => {
  const privacy = JSON.parse(readFileSync(join(dir, "client-privacy.json"), "utf8"));
  const { masked, map } = privacy.endpoints["POST /mask"].response.example as { masked: string; map: Record<string, string> };
  for (const original of Object.values(map)) assert.ok(!masked.includes(original), `${original} leaked into masked text`);
});
