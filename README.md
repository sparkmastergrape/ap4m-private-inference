# hack/ap4m — AP4M paid private inference on the XRPL EVM sidechain

AP4M (Mastercard) rail for the existing ChainAim privacy gateway: a tenant's Strands agent masks
documents on its own PC, buys one private answer per EIP-712 Voucher, and the merchant redeems the
Voucher on XRPL EVM Testnet (chain 1449000) before releasing the answer.

Design: [`DESIGN/xrplh-18`](../../DESIGN/xrplh-18-AP4M-CONSOLIDATED-DESIGN-2026-10-25.md).
Everything here is new code written for the event; nothing in `services/` was changed.

## What pre-existed, and what was built here

| Pre-existing (not ours to claim) | Built in `hack/ap4m` (all of it new) |
|---|---|
| `services/gateway` — masking, routing, decision ledger | the AP4M merchant: per-job quote, 402 → verify → infer → redeem → release, finality wait (`src/merchant/`) |
| `services/presidio` — entity detection | the per-job price, identical on agent and merchant (`src/shared/estimate.ts`) |
| `packages/route-engine` — rules classifier (MIT fork) | the agent rail: local price and session limits that refuse **before signing** (`src/agent/rail.ts`) |
| the Strands + Bedrock agent in `services/paywall` (the L1 rail) | `purchase.ts`: the kit's `buyResource` rebuilt on SDK primitives, because the kit helper cannot run on Windows |
| the XRPL L1 / t54 paywall (dormant here) | channel ops: `status`, `setup-channel`, `settle` (receipt URL per claim), `ledger-view` |
| the AP4M kit: `vendor/` SDK files, `@ap4m/sdk`, the hosted service | the payment ledger, one line per claim, no text (`src/shared/ledger.ts`) |
| `services/client-privacy` wraps the existing masking code | the demo script (`demo/demo.ts`) and the API contracts (`contracts/`) |

`services/client-privacy` is a thin loopback wrapper added for this event around masking code that
already existed. An optional Strands tool (`--agent`) is written but has **not** been run end to
end; the demo uses the direct path.

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

Build steps 1 to 8 are done. Live on XRPL EVM Testnet: masked ask, payment, redemption, answer from
a hosted model, restore on the PC, settlement and receipt. Not done: the `--agent` Strands path has
not run (Bedrock access was denied). Known limit: the input-token estimate counts bytes and ran
about 90 tokens low in one measured ask, so the quote is not yet a strict ceiling.

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
