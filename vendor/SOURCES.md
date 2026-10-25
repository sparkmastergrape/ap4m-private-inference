# Vendored AP4M files

Official hackathon files, **unmodified**. Nothing here is ours; nothing here may be edited.
If one needs changing, wrap it in `src/` instead and leave the vendored copy alone.

Both were copied from `DESIGN/REF/`, which the owner downloaded from the AP4M service.
The upstream URLs are recorded for provenance; they are not re-fetched by any build step.

| File | Upstream URL | Copied | sha256 |
|---|---|---|---|
| `ap4m-x402.mjs` | `https://hackathon.ap4m.build/sdk/ap4m-x402.mjs` | 2026-10-25 (into `hack/`, from a REF copy dated 2026-10-24) | `8db382e29135ecb8beeaa82ce5b03e3c7a2aca0f0e872dbee11b6462a9620e57` |
| `ap4m-hackathon-sdk.cjs` | `https://hackathon.ap4m.build/sdk/ap4m-hackathon-sdk.js` | 2026-10-25 (same) | `db533d84d4c15b7c71916c598f0e5e129627f50af584897cf54e9282d38ab62d` |

## Why the `.cjs` extension

`ap4m-hackathon-sdk.js` is CommonJS and this package is `"type": "module"`, so it is stored
with a `.cjs` extension and imported as a default:

```js
import sdk from "./vendor/ap4m-hackathon-sdk.cjs";
const { signIn, requestChannel, signVoucher, redeemVoucher, settle, closeChannel } = sdk;
```

`ap4m-x402.mjs` is already an ES module (`loadX402Context`, `buyResource`, `createX402Merchant`)
and is imported normally. It expects `@ap4m/sdk` and `@ap4m/sdk/participant-requests` to be
installed as npm dependencies — see "Not vendored" below.

## Licence

Both files carry the notice **"provided exclusively for the Mastercard XRPL Hackathon"** and
must not be used outside that context. They stay confined to this folder so the production
XRPL L1 / t54 path never depends on them.

## Not vendored

`@ap4m/sdk` installs from the service, not the public registry, and is NOT checked in:

```
npm install ethers@6.17.0 https://hackathon.ap4m.build/sdk/ap4m-sdk.tgz
```

That install needs the service reachable from the machine. Step 1 of the build order
(`estimate.ts`, `token-count.ts`, the boundary check and their tests) deliberately depends on
neither, so it runs and passes offline.

## Verifying a copy later

```bash
cd hack/ap4m/vendor && sha256sum -c <<'SUMS'
8db382e29135ecb8beeaa82ce5b03e3c7a2aca0f0e872dbee11b6462a9620e57 *ap4m-x402.mjs
db533d84d4c15b7c71916c598f0e5e129627f50af584897cf54e9282d38ab62d *ap4m-hackathon-sdk.cjs
SUMS
```

A mismatch means the service published a new build: re-read it before trusting the design notes
in `DESIGN/xrplh-18`, whose constraints (sections 0.1–0.3) were read off `ap4m-x402.mjs` at the
hash above.
