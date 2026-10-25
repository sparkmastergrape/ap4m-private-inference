/**
 * Quote demo: prove estimate.ts works without the AP4M service, the SDK, AWS or
 * a running stack. Nothing here touches the network or signs anything.
 *
 *   node demo/quote.ts                          every scenario
 *   node demo/quote.ts --scenario clinic-csv    one scenario
 *   node demo/quote.ts --file ../../some.txt    quote a real file by its size
 *   node demo/quote.ts --bytes 8000 --masked 4 --max-tokens 1024
 *
 * Flags: --in-tokens N (exact count instead of by size), --model NAME,
 *        --pricing PATH, --json.
 */
import { parseArgs } from "node:util";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { estimate, QuoteRefused, type Pricing, type Work } from "../src/shared/estimate.ts";

const MODELS: Record<string, { inputPerM: number; outputPerM: number }> = {
  // from config/catalog.bedrock.json
  "nemotron-nano-3-30b": { inputPerM: 0.0618, outputPerM: 0.2472 },
  // a local model costs nothing per token, so only fixed + data remain
  local: { inputPerM: 0, outputPerM: 0 },
};

type Scenario = { name: string; why: string; work: Omit<Work, "model">; model?: string };

const SCENARIOS: Scenario[] = [
  {
    name: "clinic-csv",
    why: "the 3-row clinic CSV: 296 bytes, 9 masked values, short answer",
    work: { bytes: 296, maskedFields: 9, maxTokens: 512 },
  },
  {
    name: "discharge-note",
    why: "one tenant document, a paragraph of answer",
    work: { bytes: 1_400, maskedFields: 6, maxTokens: 1024 },
  },
  {
    name: "bank-statement",
    why: "a PDF page with many identifiers",
    work: { bytes: 2_300, maskedFields: 11, maxTokens: 1024 },
  },
  {
    name: "exact-count",
    why: "the design's worked example, with Bedrock CountTokens instead of a size estimate",
    work: { bytes: 8_000, maskedFields: 0, maxTokens: 1024, inputTokens: 2_000 },
  },
  {
    name: "local-model",
    why: "a free local model: the quote is fixed + data only",
    work: { bytes: 4_096, maskedFields: 5, maxTokens: 1024 },
    model: "local",
  },
  {
    name: "over-budget",
    why: "REFUSED on purpose: a Voucher only counts up, so this must not be priced",
    work: { bytes: 40_000_000, maskedFields: 200, maxTokens: 8_192 },
  },
];

const { values } = parseArgs({
  options: {
    scenario: { type: "string" },
    file: { type: "string" },
    bytes: { type: "string" },
    masked: { type: "string" },
    "max-tokens": { type: "string" },
    "in-tokens": { type: "string" },
    model: { type: "string", default: "nemotron-nano-3-30b" },
    pricing: { type: "string", default: join(import.meta.dirname, "..", "config", "pricing.json") },
    json: { type: "boolean", default: false },
  },
});

const pricing: Pricing = JSON.parse(readFileSync(values.pricing!, "utf8"));

function rates(name: string) {
  const m = MODELS[name];
  if (!m) {
    console.error(`unknown --model ${name}; try: ${Object.keys(MODELS).join(", ")}`);
    process.exit(2);
  }
  return m;
}

function show(label: string, why: string, work: Work) {
  try {
    const q = estimate(work, pricing);
    if (values.json) {
      console.log(JSON.stringify({ scenario: label, ...q }));
      return;
    }
    console.log(`${label}`);
    console.log(`  ${why}`);
    console.log(
      `  in ${q.inTok} tok (${q.inTokSource}) · out cap ${q.outTok} tok · model $${q.modelUsd.toFixed(7)} · data $${q.dataUsd.toFixed(6)}`,
    );
    console.log(`  QUOTE ${q.totalRlusd} RLUSD${q.atMinimum ? "  (raised to the minimum)" : ""}`);
    console.log(`  challenge amount ${q.quoteWei} wei\n`);
  } catch (error) {
    if (error instanceof QuoteRefused) {
      if (values.json) {
        console.log(JSON.stringify({ scenario: label, refused: true, wouldBe: error.wouldBe, maximumPerCall: error.maximumPerCall }));
        return;
      }
      console.log(`${label}`);
      console.log(`  ${why}`);
      console.log(`  REFUSED  ${error.message}\n`);
      return;
    }
    throw error;
  }
}

const custom = values.bytes || values.file || values["in-tokens"];
if (custom) {
  let bytes = Number(values.bytes ?? 0);
  let why = "custom job";
  if (values.file) {
    bytes = statSync(values.file).size;
    why = `${values.file}, ${bytes} bytes on disk`;
  }
  show(
    "custom",
    why,
    {
      bytes,
      maskedFields: Number(values.masked ?? 0),
      maxTokens: Number(values["max-tokens"] ?? 1024),
      ...(values["in-tokens"] ? { inputTokens: Number(values["in-tokens"]) } : {}),
      model: rates(values.model!),
    },
  );
} else {
  const chosen = values.scenario ? SCENARIOS.filter((s) => s.name === values.scenario) : SCENARIOS;
  if (!chosen.length) {
    console.error(`unknown --scenario ${values.scenario}; try: ${SCENARIOS.map((s) => s.name).join(", ")}`);
    process.exit(2);
  }
  if (!values.json) {
    console.log(
      `pricing: fixed ${pricing.fixed} · perMaskedField ${pricing.perMaskedField} · perKB ${pricing.perKB} · ` +
        `costShare ${pricing.costShare} · min ${pricing.minimum} · max ${pricing.maximumPerCall} RLUSD\n`,
    );
  }
  for (const s of chosen) show(s.name, s.why, { ...s.work, model: rates(s.model ?? values.model!) });
}
