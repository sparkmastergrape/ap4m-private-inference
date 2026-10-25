# hack/ap4m — AP4M paid private inference on the XRPL EVM sidechain

AP4M (Mastercard) rail for the existing ChainAim privacy gateway: a tenant's Strands agent masks
documents on its own PC, buys one private answer per EIP-712 Voucher, and the merchant redeems the
Voucher on XRPL EVM Testnet (chain 1449000) before releasing the answer.

Design: [`DESIGN/xrplh-18`](../../DESIGN/xrplh-18-AP4M-CONSOLIDATED-DESIGN-2026-10-25.md).
Everything here is new code written for the event; nothing in `services/` was changed.

## What pre-existed, and what was built here

| Pre-existing (not ours to claim) | Built in `hack/ap4m` |
|---|---|
| `services/gateway` — masking, routing, decision ledger | the AP4M merchant (402 → verify → infer → redeem → release) |
| `services/presidio` — entity detection | the per-job quote (`src/shared/estimate.ts`) |
| `packages/route-engine` — rules classifier (MIT fork) | the agent-side AP4M rail around `buyResource` |
| the Strands + Bedrock agent loop | channel ops: setup, status, settle, receipt |
| the XRPL L1 / t54 paywall (dormant here) | the import boundary check |

## The boundary

`hack/ap4m` may import only its own `vendor/` and npm dependencies. It reaches
`services/gateway` and `services/client-privacy` **by HTTP**, never by import, and nothing in
`services/` may mention `hack/`. `npm test` fails if that is broken:

```bash
npm run check:boundaries
```

## Run order

Start client-privacy (:8787), the gateway, then the merchant (:4308):

```bash
node src/merchant/main.ts --env-file <env> --gateway http --gateway-url http://127.0.0.1:8720
```

Then the demo, one step at a time (design section 10):

```bash
node demo/demo.ts --env-file <env> --channel-id 0x... --document <csv> --step status|ask|overcap|settle|ledger
```

`overcap` is free: both refusals happen before anything is signed. `ask` and `settle` move
testnet RLUSD. `npm test` runs the unit tests and the boundary check.

## Status

Steps 1 to 8 are built. Not done: wiring `src/agent/tool.ts` into the Strands agent.

## Pricing

Per-job quote (option C in the design). The agent and the merchant run the *same*
`estimate()` so the quote in the challenge is bit-identical to the one the agent checked; money is
handled as integer micro-RLUSD and converted to wei with `BigInt`, never floating point.

Two rules worth knowing before changing anything here:

- **No refunds.** A Voucher's `cumulativeAmount` only ever rises, so a job that would cost more
  than `maximumPerCall` is *refused*, not priced. Output length cannot be predicted, so the quote
  uses the requested `max_tokens` as an upper bound.
- **The ceiling is frozen per operation.** `buyResource` stores `maximumAmount` inside the purchase
  intent and refuses to resume if it changed. Compute it once with `freezeMaximumAmount()`, store
  it on the job, and pass the stored value on every retry — see design section 0.3.

## Safety

Keys come from the environment or an untracked `.env` (names in `.env.example`); none is ever
printed, logged or sent to the AP4M service, which only needs signatures. Operator, PSP, payout-
release and admin keys belong to the service and are never configured here. The vendored SDK files
are licensed for this hackathon only — see `vendor/SOURCES.md`.
