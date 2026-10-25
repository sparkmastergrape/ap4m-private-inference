/**
 * The 3-minute demo, design section 10. Each step runs the real CLI; nothing is
 * faked or replayed.
 *
 *   node demo/demo.ts --env-file ../../../ap4m-hackathon/.env \
 *        --channel-id 0x... --document ../../test-console/samples/f3/clinic-patients.csv \
 *        --step overcap
 *
 * --step status    1. agent registered, Channel open, cap, redeemed
 *        ask       2+3. two masked paid asks; the running total rises (COSTS RLUSD)
 *        overcap   4. refusals before signing; the chain is read before and after (free)
 *        settle    5. settle now, show the receipt URL (moves RLUSD)
 *        ledger    6. joined ledger view, with the personal-data check
 *        all       1 to 6 in order
 *
 * The merchant and client-privacy must already be running (see README).
 * Real values to prove absent from the ledger are read from the document itself
 * with --forbid; this script never prints them.
 *
 * Step 4 is the one judges look for, and it is free: both refusals happen on
 * this computer, before any Voucher is signed.
 */
import { parseArgs } from "node:util";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { ethers } from "ethers";
import sdk from "../vendor/ap4m-hackathon-sdk.cjs";
import { DEFAULT_API_URL, NAMES, env, loadEnvFile, publicConfig, rpcUrl } from "../src/shared/config.ts";

const { values } = parseArgs({
  options: {
    "env-file": { type: "string", multiple: true },
    "channel-id": { type: "string" },
    document: { type: "string" },
    question: { type: "string", default: "Which patients have their next visit in November?" },
    step: { type: "string", default: "all" },
    "state-dir": { type: "string", default: ".agent-state-demo" },
    "ledger-dir": { type: "string", default: ".ap4m-ledger" },
    merchant: { type: "string", default: "http://127.0.0.1:4308" },
    forbid: { type: "string" },
  },
});

const envFiles = (values["env-file"] ?? []).flatMap((f) => ["--env-file", f]);
const channel = values["channel-id"];
const stamp = new Date().toISOString().replace(/\D/g, "").slice(2, 12);

function banner(n: number, title: string): void {
  console.log(`\n${"=".repeat(72)}\n  ${n}. ${title}\n${"=".repeat(72)}`);
}

/** Run one of the project's own CLIs and show its output as it happens. */
function run(script: string, args: string[]): number {
  const result = spawnSync(process.execPath, [script, ...args], { stdio: "inherit", env: process.env });
  return result.status ?? 1;
}

async function chain() {
  for (const file of values["env-file"] ?? []) loadEnvFile(file);
  const apiUrl = (env(NAMES.apiUrl, "AP4M API URL", false) || DEFAULT_API_URL).replace(/\/+$/, "");
  const config = await publicConfig(apiUrl);
  const provider = new ethers.JsonRpcProvider(rpcUrl(config), undefined, { staticNetwork: true });
  return { config, provider };
}

async function redeemed(): Promise<bigint> {
  const { config, provider } = await chain();
  const state = await sdk.getChannelState(provider, config.contracts.paymentLedger, channel);
  return BigInt(state.redeemed);
}

function need(name: string): string {
  const v = values[name as keyof typeof values];
  if (!v || typeof v !== "string") {
    console.error(`--${name} is required for this step`);
    process.exit(2);
  }
  return v;
}

function ask(operation: string): void {
  // A transient 502 from the hosted model is retried under the SAME operation:
  // nothing is charged until the answer exists, and the rail resumes, not re-buys.
  for (let attempt = 1; attempt <= 3; attempt++) {
    const code = run("src/agent/main.ts", [
      ...envFiles, "--channel-id", need("channel-id"), "--state-dir", values["state-dir"]!,
      "--document", resolve(need("document")), "--question", values.question!,
      "--max-tokens", "300", "--operation", operation, "--confirm",
    ]);
    if (code === 0) return;
    console.log(`\n(attempt ${attempt} ended without an answer; nothing was charged. Resuming the same operation.)`);
  }
  console.error("no answer after 3 attempts");
  process.exit(1);
}

async function main(): Promise<void> {
  const step = values.step!;
  const want = (s: string) => step === "all" || step === s;

  if (want("status")) {
    banner(1, "status: agent, Channel, cap, redeemed");
    const code = run("src/ops/status.ts", envFiles);
    if (code !== 0) process.exitCode = code;
  }

  if (want("ask")) {
    banner(2, "Ask 1: mask on this PC, quote, 402, Voucher, answer restored locally");
    ask(`demo-${stamp}-a`);
    banner(3, "Ask 2: second Voucher; the cumulative total rises");
    ask(`demo-${stamp}-b`);
  }

  if (want("overcap")) {
    banner(4, "Over-cap: the agent refuses BEFORE signing");
    const before = await redeemed();
    console.log(`chain before: redeemed ${ethers.formatUnits(before, 18)} RLUSD\n`);

    console.log("--- 4a. single-ask limit: this ask costs about 0.10, the agent is allowed 0.05 ---");
    const a = run("src/agent/main.ts", [
      ...envFiles, "--channel-id", need("channel-id"), "--state-dir", `${values["state-dir"]}-overcap`,
      "--document", resolve(need("document")), "--question", values.question!, "--max-tokens", "300",
      "--max-price", "0.05", "--operation", `demo-${stamp}-cap-a`, "--confirm",
    ]);

    console.log("\n--- 4b. session budget: 0.05 RLUSD for the whole session, this ask needs more ---");
    const b = run("src/agent/main.ts", [
      ...envFiles, "--channel-id", need("channel-id"), "--state-dir", `${values["state-dir"]}-overcap`,
      "--document", resolve(need("document")), "--question", values.question!, "--max-tokens", "300",
      "--session-budget", "0.05", "--max-price", "0.25", "--operation", `demo-${stamp}-cap-b`, "--confirm",
    ]);

    const after = await redeemed();
    console.log(`\nchain after:  redeemed ${ethers.formatUnits(after, 18)} RLUSD`);
    const ok = a !== 0 && b !== 0 && after === before;
    console.log(ok
      ? "RESULT: both asks were refused (exit non-zero) and the channel did not move: nothing was signed, nothing was paid."
      : `RESULT: UNEXPECTED. refusals exit codes ${a}, ${b}; redeemed ${after === before ? "unchanged" : `changed by ${ethers.formatUnits(after - before, 18)}`}. Another process may be paying on this channel; re-check.`);
    if (!ok) process.exitCode = 1;
  }

  if (want("settle")) {
    banner(5, "settle: move the RLUSD and get the receipt");
    const code = run("src/ops/settle.ts", [...envFiles, "--channel-id", need("channel-id"), "--ledger-dir", values["ledger-dir"]!, "--confirm"]);
    if (code !== 0) {
      console.log("\nSETTLE FAILED. The service also settles on its own; re-run: --step settle");
      process.exitCode = code;
    }
  }

  if (want("ledger")) {
    banner(6, "ledger: agent, channel, claim, model; no personal data");
    const code = run("src/ops/ledger-view.ts", [
      "--ledger-dir", values["ledger-dir"]!, "--channel-id", need("channel-id"),
      ...(values.forbid ? ["--forbid", values.forbid] : []),
    ]);
    if (code !== 0) process.exitCode = code;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
