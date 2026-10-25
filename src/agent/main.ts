/**
 * Make one paid private-inference ask through the merchant.
 *
 *   node src/agent/main.ts --env-file ../../../ap4m-hackathon/.env \
 *     --question "Which of my patients have their next visit in November?" --quote-only
 *
 *   node src/agent/main.ts --env-file <path> --question "..." --confirm
 *
 * READ-ONLY BY DEFAULT. Without --confirm it stages the job, prints the quote and
 * stops: no Voucher is signed and nothing is redeemed. --confirm signs the
 * Voucher and lets the merchant redeem it, which moves RLUSD.
 *
 * --question TEXT          what to ask
 * --documents PATH         masked document text to answer from
 * --merchant URL           merchant root (default http://127.0.0.1:4308)
 * --channel-id 0x...       which Channel to pay from (default: the one open Channel)
 * --operation NAME         purchase name; a fresh one is generated when omitted.
 *                          Pass the original name to resume an unresolved purchase.
 * --session-budget RLUSD   ceiling across this state directory (default 0.5)
 * --max-price RLUSD        refuse any single ask above this (default 0.25)
 * --state-dir PATH         purchase.json and budget.json live here
 * --agent                  let a Strands agent on Bedrock decide to call the paid tool
 *                          (--region, --model-id). It sees the question and the masked answer only.
 * --confirm                sign and pay
 * --quote-only             stage and price, then stop (the default)
 *
 * The agent key is read from the environment and never printed.
 */
import { parseArgs } from "node:util";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ethers } from "ethers";
import { loadX402Context } from "../../vendor/ap4m-x402.mjs";
import sdk from "../../vendor/ap4m-hackathon-sdk.cjs";
import { RailRefused, createRail } from "./rail.ts";
import { makeToolHandler, operationNamer } from "./tool.ts";
import { PrivacyError, assertMasked, httpPrivacy, type MaskedDocument } from "./privacy-client.ts";
import { DEFAULT_API_URL, NAMES, SetupError, env, explorerTx, loadEnvFile, publicConfig, rpcUrl } from "../shared/config.ts";

const { values } = parseArgs({
  options: {
    "env-file": { type: "string", multiple: true },
    "api-url": { type: "string" },
    question: { type: "string" },
    document: { type: "string", multiple: true },
    documents: { type: "string" },
    "privacy-url": { type: "string", default: "http://127.0.0.1:8787" },
    "show-masked": { type: "boolean", default: false },
    merchant: { type: "string", default: "http://127.0.0.1:4308" },
    "channel-id": { type: "string" },
    operation: { type: "string" },
    "session-budget": { type: "string", default: "0.5" },
    "max-price": { type: "string", default: "0.25" },
    "state-dir": { type: "string", default: ".agent-state" },
    "max-tokens": { type: "string", default: "256" },
    "masked-fields": { type: "string", default: "0" },
    agent: { type: "boolean", default: false },
    region: { type: "string", default: "ap-southeast-2" },
    "model-id": { type: "string", default: "nvidia.nemotron-nano-3-30b" },
    confirm: { type: "boolean", default: false },
    "quote-only": { type: "boolean", default: false },
  },
});

async function main(): Promise<void> {
  for (const file of values["env-file"] ?? []) loadEnvFile(file);
  if (!values.question) throw new SetupError("--question is required");

  const apiUrl = (values["api-url"] || env(NAMES.apiUrl, "AP4M API URL", false) || DEFAULT_API_URL).replace(/\/+$/, "");
  const teamName = env(NAMES.teamName, "team name");
  const key = env(NAMES.agentKey, "agent private key");

  const config = await publicConfig(apiUrl);
  const provider = new ethers.JsonRpcProvider(rpcUrl(config), undefined, { staticNetwork: true });
  let wallet: ethers.Wallet;
  try {
    // signVoucher refuses a wallet with no provider, so connect it here.
    wallet = new ethers.Wallet(key, provider);
  } catch {
    throw new SetupError("AGENT_PRIVATE_KEY is not a usable private key");
  }

  // Pick the Channel: the named one, else the single open one.
  let channelId = values["channel-id"];
  if (!channelId) {
    const session = await sdk.signIn(apiUrl, teamName, wallet);
    const channels: Record<string, unknown>[] = await sdk.listChannels(apiUrl, session.token ?? session.sessionToken ?? session);
    const open = channels.filter((c) => c?.channel_status === "open");
    if (open.length !== 1) {
      throw new SetupError(
        `${open.length} open Channels, so --channel-id is required` +
          (open.length ? `: ${open.map((c) => c.channel_id).join(", ")}` : " — open one with setup-channel.ts"),
      );
    }
    channelId = String(open[0].channel_id);
  }

  const merchant = values.merchant!.replace(/\/+$/, "");
  const context = await loadX402Context(apiUrl);
  const rail = createRail({
    context,
    provider,
    wallet,
    resourceUrl: `${merchant}/resource`,
    merchantBaseUrl: merchant,
    channelId,
    stateDirectory: resolve(values["state-dir"]!),
    sessionBudgetWei: ethers.parseUnits(values["session-budget"]!, 18),
    maxPriceWei: ethers.parseUnits(values["max-price"]!, 18),
  });

  // --document goes through the privacy service: read from disk, then mask. Only
  // the masked text is ever sent. --documents is the older raw-text flag and is
  // kept for text that is already masked.
  const privacy = httpPrivacy(values["privacy-url"]);
  let masked: MaskedDocument | undefined;
  let documents = values.documents ? readFileSync(resolve(values.documents), "utf8") : undefined;

  if (values.document?.length) {
    const parts: string[] = [];
    for (const file of values.document) {
      const extracted = await privacy.extract(resolve(file));
      parts.push(`--- ${file} (${extracted.type}) ---\n${extracted.text}`);
    }
    const joined = parts.join("\n\n");
    masked = await privacy.mask(joined);
    // Backstop before anything leaves this process.
    assertMasked(masked.masked, masked.map);
    documents = masked.masked;

    console.log(`\ndocuments  ${values.document.length} file(s), ${joined.length} chars read on this computer`);
    console.log(`masked     ${masked.maskedFields} value(s) replaced: ${JSON.stringify(masked.counts)}`);
    if (masked.cardsRemoved) console.log(`           ${masked.cardsRemoved} card number(s) deleted outright, not mapped`);
    console.log(`           the placeholder map stays here; the merchant and the model never see it`);
    if (values["show-masked"]) console.log(`\n--- what will be sent ---\n${masked.masked}\n-------------------------`);
  }
  const spent = rail.budget();
  console.log(`service    ${apiUrl}`);
  console.log(`network    ${config.network.name}, chain ${config.network.chainId}`);
  console.log(`rlusd      ${config.contracts.rlusdToken}`);
  console.log(`agent      ${wallet.address}`);
  console.log(`channel    ${channelId}`);
  console.log(`merchant   ${merchant}`);
  console.log(`budget     ${ethers.formatUnits(spent.spentWei, 18)} of ${values["session-budget"]} RLUSD spent in ${resolve(values["state-dir"]!)}`);

  const pending = rail.pendingPurchase();
  if (pending && !pending.complete) {
    console.log(`\nunresolved purchase: ${pending.operation}`);
    console.log(`Resume it with --operation ${pending.operation} and the same question before starting another.`);
    if (values.operation !== pending.operation) return;
  }

  if (!values.confirm) {
    // Quote only: this stages the job and prices it. Nothing is signed.
    const quote = await rail.quote({
      request: {
        model: "chainaim/auto",
        max_tokens: Number(values["max-tokens"]),
        messages: [{ role: "user", content: documents ? `${values.question}\n\nDocuments:\n${documents}` : values.question }],
      },
      maskedFields: masked?.maskedFields ?? Number(values["masked-fields"]),
      maxTokens: Number(values["max-tokens"]),
      operation: "quote-only",
    });
    console.log(`\nquote      ${quote.rlusd} RLUSD  (${quote.amount} wei)`);
    console.log(`job        ${quote.jobId}`);
    console.log(`breakdown  ${JSON.stringify(quote.breakdown)}`);
    console.log(`\nDRY RUN: no Voucher was signed and no RLUSD moved.`);
    console.log(`Re-run with --confirm to buy this answer.`);
    return;
  }

  const handle = makeToolHandler({
    ask: rail.ask,
    nextOperation: values.operation ? () => values.operation! : operationNamer("ask"),
    maskedFields: () => masked?.maskedFields ?? Number(values["masked-fields"]),
  });

  console.log(`\nbuying the answer (this signs a Voucher and the merchant redeems it on chain)...`);
  let result: Awaited<ReturnType<typeof handle>>;
  if (values.agent) {
    // The question goes to Bedrock, so it must hold no personal data. Refuse here, not after.
    const scan = await privacy.scan(values.question);
    if (scan.total > 0) throw new SetupError(`the question holds ${scan.total} personal value(s); the agent's model would see it. Reword it.`);
    const { runStrandsAgent } = await import("./strands.ts");
    const run = await runStrandsAgent({
      handler: handle,
      documents,
      question: values.question,
      maxTokens: Number(values["max-tokens"]),
      region: values.region!,
      modelId: values["model-id"]!,
    });
    console.log(`agent      called the paid tool ${run.calls} time(s); its words: ${run.reply.trim().replace(/s+/g, " ")}`);
    if (!run.tool) {
      console.log("\nThe model did not call the paid tool, so nothing was bought.");
      process.exitCode = 1;
      return;
    }
    result = run.tool;
  } else {
    result = await handle({ question: values.question, documents, maxTokens: Number(values["max-tokens"]) });
  }

  if (!result.ok) {
    console.log(`\nREFUSED    ${result.refused}`);
    if (result.detail && Object.keys(result.detail).length) console.log(`detail     ${JSON.stringify(result.detail)}`);
    process.exitCode = 1;
    return;
  }

  console.log(`\npaid       ${result.cost.rlusd} RLUSD  (${result.cost.wei} wei)`);
  console.log(`redemption ${result.payment.redemption}`);
  console.log(`claim      ${result.payment.claimId}`);
  console.log(`tx         ${explorerTx(config, result.payment.transactionHash)}`);
  if (result.model) console.log(`model      ${result.model}`);
  if (result.truncated) console.log(`note       the answer was longer than the 64 KiB resource limit and was truncated`);

  // The answer comes back talking about placeholders. Put the real values back
  // here, on this computer, after the answer has been paid for.
  if (masked) {
    const restored = await privacy.restore(result.answer, masked.map);
    console.log(`\nanswer as paid for (placeholders, as the model saw them)\n${result.answer}`);
    console.log(`\nanswer restored on this computer\n${restored.text}`);
    if (restored.unresolved) {
      console.log(`\nnote       ${restored.unresolved} placeholder(s) could not be resolved from the local map.`);
      console.log(`           Those were masked by the server side, which this computer has no values for.`);
    }
  } else {
    console.log(`\nanswer\n${result.answer}`);
  }
  const after = rail.budget();
  console.log(`\nbudget     ${ethers.formatUnits(after.spentWei, 18)} of ${values["session-budget"]} RLUSD spent across ${after.purchases.length} purchase(s)`);
}

main().catch((error) => {
  console.error(error instanceof SetupError || error instanceof RailRefused ? error.message : error);
  process.exit(1);
});
