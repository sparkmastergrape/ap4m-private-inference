<#
  A paced, narrated run of the free steps plus the recorded evidence, made to be screen-recorded.

    LIVE      runs now: services, masking and the price quote (nothing is paid), the over-cap refusals
    RECORDED  reads what already happened: the payment ledger and the chain

  It spends nothing and signs nothing: the quote step is --quote-only and both refusals happen before a Voucher is signed.
  Pass the SAME env file the other tools use. No key or RPC URL is printed; output is also scrubbed of quiknode URLs.

  .\demo\record-demo.ps1 -EnvFile ..\..\..\ap4m-hackathon\.env -Document ..\..\test-console\samples\f3\clinic-patients.csv -Channel 0x...
  Add -SetupWindow to size the console and font for a recording, and -SyncDir <folder> to hand the recorder a
  ready.flag / go.flag / done.flag handshake (see demo\RECORDING.md).
#>
param(
  [Parameter(Mandatory)] [string] $EnvFile,
  [Parameter(Mandatory)] [string] $Document,
  [Parameter(Mandatory)] [string] $Channel,
  [string] $Root = '',
  [string] $Forbid = 'Ravi Kumar,Lakshmi Iyer,98765 43210',
  [string] $Question = 'Which patients have their next visit in November?',
  [string] $EndNote = '',
  [string] $SyncDir = '',
  [switch] $SetupWindow
)

$ErrorActionPreference = 'Continue'
if (-not $Root) { $Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path) }
$env:NODE_NO_WARNINGS = '1'
$Host.UI.RawUI.WindowTitle = 'PrivaSpend demo'

if ($SetupWindow) {
  try {
    Add-Type -TypeDefinition @"
using System; using System.Runtime.InteropServices;
public class ConFont {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public struct CFI { public uint cbSize; public uint nFont; public short X; public short Y; public int Family; public int Weight;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=32)] public string Face; }
  [DllImport("kernel32.dll", SetLastError=true)] public static extern IntPtr GetStdHandle(int n);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool GetCurrentConsoleFontEx(IntPtr h, bool max, ref CFI i);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool SetCurrentConsoleFontEx(IntPtr h, bool max, ref CFI i);
  public static void Set(short y) {
    IntPtr h = GetStdHandle(-11); CFI i = new CFI(); i.cbSize = (uint)Marshal.SizeOf(typeof(CFI));
    GetCurrentConsoleFontEx(h, false, ref i); i.Y = y; i.X = 0; i.Face = "Consolas"; i.Family = 54; i.Weight = 400;
    SetCurrentConsoleFontEx(h, false, ref i);
  }
}
"@
    [ConFont]::Set(18)
  } catch { }
  cmd /c "chcp 65001 >nul & mode con: cols=132 lines=46" | Out-Null
  $Host.UI.RawUI.BackgroundColor = 'Black'
}
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
Clear-Host

function Sync($name) { if ($SyncDir) { New-Item -ItemType File -Force -Path (Join-Path $SyncDir $name) | Out-Null } }
if ($SyncDir) {
  Sync 'ready.flag'
  while (-not (Test-Path (Join-Path $SyncDir 'go.flag'))) { Start-Sleep -Milliseconds 200 }
}

# --- helpers ------------------------------------------------------------------------------------
$Hide = 'https?://[^\s/]*quiknode\.pro/\S*'
function Scrub($lines) { $lines | ForEach-Object { "$_" -replace $Hide, '[rpc hidden]' } }
function Banner($tag, $text, $color) {
  Write-Host ''
  Write-Host ("[{0}] " -f $tag) -NoNewline -ForegroundColor $color
  Write-Host $text -ForegroundColor White
  Start-Sleep -Seconds 3
}
function ShowCmd($text) {
  Write-Host '$ ' -NoNewline -ForegroundColor Green
  foreach ($c in $text.ToCharArray()) { Write-Host $c -NoNewline; Start-Sleep -Milliseconds 14 }
  Write-Host ''; Start-Sleep -Milliseconds 700
}
function Out-Paced($lines, $ms) { foreach ($l in $lines) { Write-Host $l; Start-Sleep -Milliseconds $ms } }

Set-Location $Root
$Stamp = Get-Date -Format 'HHmmss'
$ShortCh = $Channel.Substring(0, [Math]::Min(9, $Channel.Length)) + '...'
$DocName = Split-Path -Leaf $Document

# --- title card ---------------------------------------------------------------------------------
Write-Host ''
Write-Host '  PrivaSpend' -ForegroundColor Yellow
Write-Host '  An agent that buys private answers: masked on its own PC, paid per answer,' -ForegroundColor White
Write-Host '  refused before it signs, proven from the chain.' -ForegroundColor White
Write-Host ''
Write-Host '  XRPL EVM Testnet | AP4M | RLUSD' -ForegroundColor DarkGray
Write-Host ''
Write-Host '  LIVE     = runs now, on this PC' -ForegroundColor Green
Write-Host '  RECORDED = the paid asks already in the payment ledger' -ForegroundColor Yellow
Start-Sleep -Seconds 6

# --- 1 services ---------------------------------------------------------------------------------
Banner 'LIVE' '1/5  The privacy service and the seller are running on this computer' Green
ShowCmd 'curl http://127.0.0.1:8787/healthz   (privacy, on this PC)'
Write-Host (curl.exe -s http://127.0.0.1:8787/healthz)
ShowCmd 'curl http://127.0.0.1:4308/healthz   (the seller)'
Write-Host (curl.exe -s http://127.0.0.1:4308/healthz)
Start-Sleep -Seconds 3

# --- 2 mask + quote -----------------------------------------------------------------------------
Banner 'LIVE' '2/5  Mask the document on this PC, then read the price. Nothing is paid.' Green
ShowCmd "node src/agent/main.ts --channel-id $ShortCh --document $DocName --show-masked --quote-only"
$o = & node src/agent/main.ts --env-file $EnvFile --channel-id $Channel --state-dir .agent-state-rec --document $Document `
  --question $Question --max-tokens 300 --operation "rec-quote-$Stamp" --show-masked --quote-only 2>&1
$o = Scrub $o | Where-Object { $_ -notmatch 'Warning|trace-warnings|^service|^network|^rlusd|^agent  |^merchant|^budget|^Columns|^-+$|^--- \.\.|^job ' }
$maskLine = ($o | Select-String -Pattern '(\d+) value\(s\) replaced' | Select-Object -First 1)
Out-Paced $o 150
Start-Sleep -Seconds 9

# --- 3 over-cap ---------------------------------------------------------------------------------
Banner 'LIVE' '3/5  Spend limits: the agent refuses BEFORE it signs anything' Green
ShowCmd "node demo/demo.ts --channel-id $ShortCh --document $DocName --step overcap"
$o = & node demo/demo.ts --env-file $EnvFile --channel-id $Channel --document $Document --step overcap 2>&1
$o = Scrub $o | Where-Object { $_ -notmatch 'Warning|trace-warnings|^documents|^masked|placeholder map|^service|^network|^rlusd|^agent  |^merchant|^budget' }
$refused = @($o | Where-Object { $_ -match '^REFUSED' }).Count
Out-Paced $o 160
Start-Sleep -Seconds 7

# --- 4 ledger -----------------------------------------------------------------------------------
Clear-Host
Banner 'RECORDED' '4/5  The paid asks in the ledger, and a check that no patient data is in it' Yellow
ShowCmd "node src/ops/ledger-view.ts --channel-id $ShortCh --forbid `"$Forbid`""
$o = & node src/ops/ledger-view.ts --channel-id $Channel --forbid $Forbid 2>&1
$o = Scrub $o | ForEach-Object { "$_" -replace '(receipt https?://\S*?/claims/0x[0-9a-f]{6})[0-9a-f]+/0x[0-9a-f]+\.json', '$1...' }
$askCount = @($o | Where-Object { $_ -match '^\s+paid ' }).Count
$piiLine = ($o | Where-Object { $_ -match '^personal data:' } | Select-Object -First 1)
Out-Paced $o 110
Start-Sleep -Seconds 8

# --- 5 chain ------------------------------------------------------------------------------------
Clear-Host
Banner 'RECORDED' '5/5  The same asks on the chain, read from the RPC node: nothing is signed or sent' Yellow
ShowCmd 'node src/ops/chain-proof.ts   (RPC url hidden: it can hold a secret token)'
$o = & node src/ops/chain-proof.ts --env-file $EnvFile --channel-id $Channel 2>&1
$o = Scrub $o
$chainLine = ($o | Where-Object { $_ -match 'redeems and' } | Select-Object -First 1)
Out-Paced $o 80
Start-Sleep -Seconds 14

# --- end card (every figure is read from the output above, none is typed in) -------------------
Clear-Host
Write-Host ''
Write-Host '  What you just saw' -ForegroundColor Yellow
Write-Host ''
if ($maskLine)  { Write-Host ("  - Masked on this PC: {0}" -f $maskLine.Line.Trim()) -ForegroundColor White }
if ($refused)   { Write-Host ("  - {0} asks refused before signing; the channel did not move" -f $refused) -ForegroundColor White }
if ($askCount)  { Write-Host ("  - {0} paid asks in the ledger, each with its redeem transaction" -f $askCount) -ForegroundColor White }
if ($piiLine)   { Write-Host ("  - {0}" -f $piiLine) -ForegroundColor White }
if ($chainLine) { Write-Host ("  - On chain: {0}" -f $chainLine.Trim()) -ForegroundColor White }
if ($EndNote)   { Write-Host ''; Write-Host "  $EndNote" -ForegroundColor DarkGray }
Start-Sleep -Seconds 9
Sync 'done.flag'
Start-Sleep -Seconds 2
