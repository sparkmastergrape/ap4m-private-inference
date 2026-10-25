/**
 * settle — move redeemed RLUSD from the vault to the payout wallet now, and
 * keep the receipt.
 *
 *   node src/ops/settle.ts --env-file ../../../ap4m-hackathon/.env            dry run
 *   node src/ops/settle.ts --env-file <path> --confirm                        settle
 *
 * Redemption (what the merchant does per ask) only advances the claim watermark.
 * Settlement is the step that moves tokens. The AP4M service settles every
 * payment on its own; this only makes it happen sooner and hands back the
 * receipt. DRY RUN BY DEFAULT: without --confirm it signs in (gasless) and
 * reads the channel, and nothing is settled.
 *
 * --channel-id 0x...   which Channel (default: the one open Channel)
 * --ledger-dir PATH    where the settlement line is appended (default .ap4m-ledger)
 * --claim 0x...        print the receipt for this claim (prefix is enough; repeatable)
 * --confirm            call settle
 *
 * The line written to the ledger holds ids, the cumulative amount and the
 * receipt URL: no text of any kind (see shared/ledger.ts).
 */
import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { ethers } from "ethers";
import sdk from "../../vendor/ap4m-hackathon-sdk.cjs";
import { DEFAULT_API_URL, NAMES, SetupError, env, explorerTx, loadEnvFile, publicConfig, rpcUrl } from "../shared/config.ts";
import { Ledger } from "../shared/ledger.ts";

const { values } = parseArgs({
  options: {
    "env-file": { type: "string", multiple: true },
    "api-url": { type: "string" },
    "channel-id": { type: "string" },
    "ledger-dir": { type: "string", default: ".ap4m-ledger" },
    claim: { type: "string", multiple: true },
    confirm: { type: "boolean", default: false },
  },
});

const rlusd = (wei: unknown): string => ethers.formatUnits(BigInt(String(wei ?? 0)), 18);

type Settled = {
  settlement_tx?: string;
  payout_tx?: string;
  amount_rlusd?: string;
  recipient?: string;
  claim_id?: string;
  channel_id?: string;
  claims_settled?: number;
  receipt_url?: string | null;
  receipts?: { claim_id: string; amount_rlusd: string; receipt_url: string | null }[];
};

async function main(): Promise<void> {
  for (const file of values["env-file"] ?? []) loadEnvFile(file);
  const apiUrl = (values["api-url"] || env(NAMES.apiUrl, "AP4M API URL", false) || DEFAULT_API_URL).replace(/\/+$/, "");
  const teamName = env(NAMES.teamName, "team name");
  const key = env(NAMES.agentKey, "agent private key");

  const config = await publicConfig(apiUrl);
  const provider = new ethers.JsonRpcProvider(rpcUrl(config), undefined, { staticNetwork: true });
  const wallet = new ethers.Wallet(key, provider);
  const session = await sdk.signIn(apiUrl, teamName, wallet);
  const token: string = session.token ?? session.sessionToken ?? session;

  let channelId = values["channel-id"];
  if (!channelId) {
    const channels: Record<string, unknown>[] = await sdk.listChannels(apiUrl, token);
    const open = channels.filter((c) => c?.channel_status === "open");
    if (open.length !== 1) throw new SetupError(`${open.length} open Channels, so --channel-id is required`);
    channelId = String(open[0].channel_id);
  }

  const state = await sdk.getChannelState(provider, config.contracts.paymentLedger, channelId);
  console.log(`service    ${apiUrl}`);
  console.log(`channel    ${channelId}`);
  console.log(`cap        ${rlusd(state.cap)} RLUSD`);
  console.log(`redeemed   ${rlusd(state.redeemed)} RLUSD`);

  if (!values.confirm) {
    console.log(`\nDRY RUN: nothing was settled. Re-run with --confirm to settle ${rlusd(state.redeemed)} RLUSD now.`);
    return;
  }

  console.log(`\nsettling (this moves RLUSD from the vault to the payout wallet; it can take up to two minutes)...`);
  const done = (await sdk.settle(apiUrl, token, channelId)) as Settled;

  console.log(`latest     ${done.amount_rlusd} RLUSD (the most recent claim only) of ${done.claims_settled} settled on this channel`);
  console.log(`recipient  ${done.recipient}`);
  if (done.payout_tx) console.log(`payout tx  ${explorerTx(config, done.payout_tx)}`);
  if (done.settlement_tx) console.log(`settle tx  ${explorerTx(config, done.settlement_tx)}`);

  const receiptUrl = done.receipt_url ? new URL(done.receipt_url, apiUrl).href : undefined;
  console.log(`receipt    ${receiptUrl ?? "not published yet"}  (latest claim)`);
  // Print only the claims asked for, else the three most recent, not all of them.
  const wanted = values.claim?.length ? (done.receipts ?? []).filter((r) => values.claim!.some((c) => r.claim_id.startsWith(c))) : (done.receipts ?? []).slice(0, 3);
  for (const r of wanted) console.log(`claim      ${r.claim_id}  ${r.amount_rlusd} RLUSD\n           ${r.receipt_url ?? "no receipt yet"}`);
  if (values.claim?.length && wanted.length === 0) console.log(`claim      none of ${values.claim.join(", ")} found among ${done.receipts?.length ?? 0} receipts`);

  // One line per claim. The top-level receipt_url and amount_rlusd describe only
  // the LATEST claim, so they must not stand in for the whole channel.
  const ledger = new Ledger(resolve(values["ledger-dir"]!));
  const ts = new Date().toISOString();
  const already = ledger.claimsWithLine("settlement");
  let written = 0;
  for (const r of done.receipts ?? []) {
    if (already.has(r.claim_id)) continue;
    written++;
    ledger.write({
      ts,
      kind: "settlement",
      channelId,
      claimId: r.claim_id,
      amountWei: ethers.parseUnits(r.amount_rlusd, 18).toString(),
      settleTx: done.settlement_tx,
      payoutTx: done.payout_tx,
      receiptUrl: r.receipt_url ? new URL(r.receipt_url, apiUrl).href : undefined,
      status: "settled",
    });
  }
  console.log(`ledger     ${written} settlement line(s) appended (${(done.receipts?.length ?? 0) - written} already recorded) in ${resolve(values["ledger-dir"]!)}`);
}

main().catch((error) => {
  console.error(error instanceof SetupError ? error.message : error);
  process.exit(1);
});
