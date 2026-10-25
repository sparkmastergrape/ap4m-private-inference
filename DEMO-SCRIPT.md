# Live demo script (3 minutes)

The judges asked for a live run with no pre-recorded output. Everything below runs live
on XRPL EVM Testnet. Run from `hack/ap4m`.

## Before the judges arrive (do this 10 minutes ahead)

1. Services up: client-privacy (:8787), gateway container (:8720), merchant (:4308).
   `curl -s http://127.0.0.1:8787/healthz http://127.0.0.1:4308/healthz` — both `ok`.
2. **A channel with room.** One ask costs about 0.105 RLUSD. Check headroom with
   `node src/ops/status.ts --env-file <env>`. Rehearse on a different channel from the one you demo on.
3. Set the shell variables once:

```bash
ENV=../../../ap4m-hackathon/.env
CH=0x...your open channel id...
DOC=../../test-console/samples/f3/clinic-patients.csv
```

4. Open two browser tabs: the explorer at `https://explorer.testnet.xrplevm.org`, and the seller's address page.
5. Keep a **fallback ask ready**: pick the operation name now (`OP=demo-live-1`). If the model
   returns a 502 you re-run the same command and it resumes without charging again.

## The run

**0:00 — The pitch, 15 seconds.** Say: "A clinic's agent needs an answer about patient records.
It masks the names on its own PC, pays per answer on-chain, and gets nothing until the
payment is confirmed."

**0:15 — Seller balance before.**

```bash
node src/ops/balance.ts --env-file $ENV
```

Say the seller number out loud. This is the number judges will check afterward.

**0:30 — The 402, shown by hand.** Stage a job (free), then ask for the resource with no payment.

```bash
JOB=$(curl -s -X POST http://127.0.0.1:4308/jobs -H 'content-type: application/json' \
  -d "{\"channelId\":\"$CH\",\"request\":{\"model\":\"chainaim/auto\",\"max_tokens\":100,\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]},\"maxTokens\":100}" \
  | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).jobId')
curl -si http://127.0.0.1:4308/resource -H "X-AP4M-CHANNEL-ID: $CH" -H "X-CHAINAIM-JOB: $JOB" | head -4
```

Point at `402 Payment Required` and `PAYMENT-REQUIRED`. Say: "No payment, no answer."

**0:50 — The agent pays, unattended.**

```bash
node src/agent/main.ts --env-file $ENV --channel-id $CH --state-dir .agent-state-live \
  --document $DOC --question "Which patients have their next visit in November?" \
  --max-tokens 300 --operation $OP --confirm
```

Talk while it runs (it takes 20 to 60 seconds): "Nine personal values were replaced on this
PC. The merchant and the model only see placeholders. The agent read the price from the 402,
signed a Voucher, the merchant redeemed it on chain, and only then released the answer."

When it prints, point at: `paid`, the `tx` link, then the two answers (placeholders, then the
real names restored locally).

If you get `502 inference_failed`: say "nothing was charged, the answer did not exist yet" and
run the same command again with the same `$OP`.

**1:50 — Over-cap, free.** The agent refuses before signing.

```bash
node demo/demo.ts --env-file $ENV --channel-id $CH --document $DOC --step overcap
```

Point at the two `REFUSED` lines and the last line: the channel total did not move.
Say: "No human decided that. The limits are the agent's own."

**2:15 — Seller balance after, and the proof.**

```bash
node src/ops/balance.ts --env-file $ENV
```

The seller number is up by the price of the answer. Then in the explorer open the `tx` link from
the ask (the redemption at the PaymentLedger contract) and the payout transaction one block
later: vault to seller, same amount. The service pays out automatically; you do not need to call settle.

**2:45 — The ledger.**

```bash
node src/ops/ledger-view.ts --channel-id $CH --forbid "Ravi Kumar,Lakshmi Iyer,98765 43210"
```

Say: "One line per answer, joining agent, channel, claim and model. The check at the bottom proves
no patient data is in it."

## What not to say

- Do not call the agent's decision "an LLM deciding". It is a policy: price limits and a session
  budget. The Strands agent path is not run.
- Do not promise the explorer names the event. The contract is unverified on the explorer, so it
  shows the transaction and its log, not the event name (filing `07`).
- Do not run `settle` live. It hung for 5 minutes once; the automatic payout already does the job.
