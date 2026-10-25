# Recording the demo

`demo/record-demo.ps1` is a paced, narrated run for a screen recording. It spends nothing and signs nothing.

| Part | What it does | Moves RLUSD |
|---|---|---|
| LIVE 1 | health of the privacy service and the seller | no |
| LIVE 2 | masks the document on this PC and reads the price (`--quote-only`) | no |
| LIVE 3 | `demo.ts --step overcap`: two refusals before a Voucher is signed | no |
| RECORDED 4 | `ledger-view.ts` over the paid asks already in the ledger, with the no-personal-data check | no |
| RECORDED 5 | `chain-proof.ts`: each ask's redeem and RLUSD payout, read from the RPC node | no |

It does **not** make a new paid ask. That needs an open channel with room (about 0.105 RLUSD per ask); use
`DEMO-SCRIPT.md` for a live paid run. The end card prints only figures it read from the output above.

## Run it

```powershell
.\demo\record-demo.ps1 -EnvFile <env> -Document <csv> -Channel 0x<channel id> -SetupWindow
```

Needs the privacy service (:8787), the gateway and the merchant (:4308) running, as in the README.

## `chain-proof.ts` and secrets

`node src/ops/chain-proof.ts --env-file <env> --channel-id 0x...` reads the RPC from `AP4M_RPC_URL` (or the service's
own). A QuickNode URL carries an access token, so the tool never prints the URL, only `QuickNode RPC` or `RPC node`,
and the script also scrubs any `*.quiknode.pro` URL from what it shows. Keep your env file out of the screen
capture and out of git (`.env*` is ignored).

## Recording one console window with ffmpeg (Windows)

`gdigrab` captures a single window by title, so nothing else on your screen is recorded. Open a classic console
window, start the script with `-SetupWindow -SyncDir <folder>`, start ffmpeg once `ready.flag` appears, then create
`go.flag`; the script writes `done.flag` when it finishes.

```powershell
ffmpeg -y -f gdigrab -framerate 15 -draw_mouse 0 -i "title=PrivaSpend demo" `
  -vf "pad=ceil(iw/2)*2:ceil(ih/2)*2" -c:v libx264 -preset veryfast -crf 22 -pix_fmt yuv420p out.mkv
```

Quote the whole `title=...` argument; unquoted, ffmpeg reads only `title=PrivaSpend`. Stop ffmpeg after `done.flag`
and remux with `ffmpeg -i out.mkv -c copy out.mp4`.
