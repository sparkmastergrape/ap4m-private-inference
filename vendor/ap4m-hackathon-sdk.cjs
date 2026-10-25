/**
 * AP4M Hackathon SDK — FOR HACKATHON USE ONLY
 *
 * This SDK is provided exclusively for the Mastercard XRPL Hackathon.
 * It is not a production library and must not be used outside of the hackathon context.
 *
 * Usage:
 *   const { signIn, requestChannel, listChannels, listMerchants, signVoucher, redeemVoucher, closeChannel, settle, getChannelState } = require('./ap4m-hackathon-sdk');
 *   // In a project with "type": "module", download it as ap4m-hackathon-sdk.cjs and:
 *   // import sdk from './ap4m-hackathon-sdk.cjs';
 *
 * Network values (RPC URL, chain ID, contract addresses) come from the service: <service>/llms.txt
 * or GET <service>/public/config.
 */

'use strict';


// ABI fragment for the one on-chain call your agent makes directly
const PAYMENT_LEDGER_ABI = [
  'function redeemVoucher((bytes32 channelId, uint256 cumulativeAmount) voucher, bytes agentSignature) returns (bytes32 claimId, uint256 amount, bytes32 digest)',
];

// Internal — full 18-field channels() ABI matching the Channel struct exactly:
// [0]=allocationId [1]=merchantPspId [2]=requestDigest [3]=authorityAttestationId
// [4]=merchantAttestationId [5]=merchantId [6]=latestVoucherDigest
// [7]=cap [8]=redeemed [9]=agent [10]=allocationGeneration [11]=status
// [12]=payout [13]=merchantGeneration [14]=merchantPspSigner
// [15]=merchantPspSignerGeneration [16]=validAfter [17]=validBefore
const _CHANNELS_ABI = [
  'function channels(bytes32 channelId) view returns (bytes32,bytes32,bytes32,bytes32,bytes32,bytes32,bytes32,uint256,uint256,address,uint64,uint8,address,uint64,address,uint64,uint64,uint64)',
];

/**
 * Sign in to the AP4M service with a team wallet (the funding wallet or the Agent wallet).
 * The wallet signs a one-time challenge message; nothing is sent on-chain.
 *
 * @param {string}                  apiUrl    AP4M service base URL
 * @param {string}                  teamName  Your registered team name
 * @param {import('ethers').Signer} wallet    Your funding or Agent wallet
 * @returns {Promise<{ token: string, expiresInSeconds: number }>}  Session; send token as a Bearer token
 */
async function signIn(apiUrl, teamName, wallet) {
  const address = await wallet.getAddress();
  const challengeResp = await fetch(`${apiUrl}/public/participant/challenge`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ teamName, wallet: address }),
  });
  const challenge = await challengeResp.json();
  if (!challengeResp.ok) throw new Error(`sign-in challenge failed (${challengeResp.status}): ${challenge.error ?? JSON.stringify(challenge)}`);
  const signature = await wallet.signMessage(challenge.message);
  const sessionResp = await fetch(`${apiUrl}/public/participant/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ challengeId: challenge.challengeId, signature }),
  });
  const session = await sessionResp.json();
  if (!sessionResp.ok) throw new Error(`sign-in failed (${sessionResp.status}): ${session.error ?? JSON.stringify(session)}`);
  return session;
}

/**
 * List other teams' Merchants your Agent can open a Channel to, when the organizers turn on
 * cross-team payments; otherwise an empty list, and Channels pay your own team's Merchant.
 * Pass a merchant_id to requestChannel as options.merchantId.
 *
 * @param {string} apiUrl  AP4M service base URL
 * @returns {Promise<Array<{ team_name: string, merchant_id: string, payout: string }>>}
 */
async function listMerchants(apiUrl) {
  const resp = await fetch(`${apiUrl}/public/merchants`);
  const data = await resp.json();
  if (!resp.ok) throw new Error(`listMerchants failed (${resp.status}): ${data.error ?? JSON.stringify(data)}`);
  return data.merchants;
}

/**
 * Open a payment Channel to one of your team's Merchants.
 * Your Agent wallet sends one vault transaction (it needs gas); the AP4M service
 * then binds the Merchant payout and opens the Channel. Resolves once the Channel is open.
 *
 * @param {string}                  apiUrl       AP4M service base URL
 * @param {string}                  teamToken    Your team session token
 * @param {import('ethers').Wallet} agentWallet  Your Agent wallet
 * @param {{ capRlusd: string|number, merchantId?: string, rpcUrl?: string, timeoutMs?: number }} options
 *   capRlusd   Spending limit for this Channel, in RLUSD
 *   merchantId Merchant to pay; defaults to your team's Merchant
 *   rpcUrl     Chain RPC when agentWallet is not connected to a provider
 * @returns {Promise<{ channel_id: string, channel_status: string, cap_wei: string, payout: string, merchant_id: string }>}
 */
async function requestChannel(apiUrl, teamToken, agentWallet, options) {
  const { ethers } = await _loadEthers();
  const headers = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${teamToken}` };
  const prepareResp = await fetch(`${apiUrl}/public/participant/channel-requests/prepare`, {
    method: 'POST', headers, body: JSON.stringify({ cap_rlusd: String(options.capRlusd), merchant_id: options.merchantId }),
  });
  const prepared = await prepareResp.json();
  if (!prepareResp.ok) throw new Error(`channel request failed (${prepareResp.status}): ${prepared.error ?? JSON.stringify(prepared)}`);
  const signer = agentWallet.provider ? agentWallet : agentWallet.connect(new ethers.JsonRpcProvider(options.rpcUrl));
  const tx = await signer.sendTransaction({ to: prepared.to, data: prepared.data });
  await tx.wait();
  const recordResp = await fetch(`${apiUrl}/public/participant/channel-requests`, {
    method: 'POST', headers, body: JSON.stringify({ tx_hash: tx.hash }),
  });
  let channel = await recordResp.json();
  if (!recordResp.ok) throw new Error(`channel request was sent (${tx.hash}) but not recorded (${recordResp.status}): ${channel.error ?? JSON.stringify(channel)}`);
  const deadline = Date.now() + (options.timeoutMs ?? 180000);
  while (channel.channel_status !== 'open') {
    if (channel.channel_status === 'failed') throw new Error(`Channel ${channel.channel_id} failed: ${channel.failure}`);
    if (Date.now() > deadline) throw new Error(`Channel ${channel.channel_id} is still ${channel.channel_status}; check listChannels later.`);
    await new Promise((resolve) => setTimeout(resolve, 2000));
    channel = (await listChannels(apiUrl, teamToken)).find((entry) => entry.channel_id === channel.channel_id) ?? channel;
  }
  return channel;
}

/**
 * List your team's Channels and their status (requested, bound, open, closed or failed).
 *
 * @param {string} apiUrl     AP4M service base URL
 * @param {string} teamToken  Your team session token
 * @returns {Promise<Array<{ channel_id: string, channel_status: string, cap_wei: string, payout: string, merchant_id: string, failure: string|null }>>}
 */
async function listChannels(apiUrl, teamToken) {
  const resp = await fetch(`${apiUrl}/public/participant/channels`, { headers: { 'Authorization': `Bearer ${teamToken}` } });
  const data = await resp.json();
  if (!resp.ok) throw new Error(`listChannels failed (${resp.status}): ${data.error ?? JSON.stringify(data)}`);
  return data.channels;
}

/**
 * Read the state of your payment channel.
 *
 * @param {import('ethers').Provider} provider   ethers.js provider connected to the service's RPC
 * @param {string}                    ledgerAddress  PaymentLedger contract address
 * @param {string}                    channelId      Your channel ID (bytes32 hex)
 * @returns {Promise<{ cap: bigint, redeemed: bigint, validBefore: bigint, status: number }>}
 */
async function getChannelState(provider, ledgerAddress, channelId) {
  const { ethers } = await _loadEthers();
  const contract = new ethers.Contract(ledgerAddress, _CHANNELS_ABI, provider);
  const result = await contract.channels(channelId);
  return {
    cap: result[7],
    redeemed: result[8],
    validBefore: result[17],
    status: Number(result[11]),
  };
}

/**
 * Sign a payment voucher off-chain with your agent wallet.
 *
 * @param {import('ethers').Wallet} wallet         Your agent wallet, connected to the RPC from <service>/llms.txt
 * @param {string}                  ledgerAddress  PaymentLedger contract address
 * @param {string}                  channelId      Your channel ID (bytes32 hex)
 * @param {bigint}                  cumulativeAmount  Total cumulative amount in RLUSD (18 decimals)
 * @returns {Promise<string>}  EIP-712 signature
 */
async function signVoucher(wallet, ledgerAddress, channelId, cumulativeAmount) {
  await _loadEthers();
  // The Voucher is signed for the chain the wallet is connected to, so it cannot target the wrong one.
  if (!wallet.provider) throw new Error('signVoucher: connect the wallet to the RPC from <service>/llms.txt first (wallet.connect(provider))');
  const chainId = (await wallet.provider.getNetwork()).chainId;
  const domain = {
    name: 'AP4M Payment Ledger',
    version: '1',
    chainId,
    verifyingContract: ledgerAddress,
  };
  const types = {
    Voucher: [
      { name: 'channelId', type: 'bytes32' },
      { name: 'cumulativeAmount', type: 'uint256' },
    ],
  };
  return wallet.signTypedData(domain, types, { channelId, cumulativeAmount });
}

/**
 * Sign and submit a voucher to the PaymentLedger contract.
 *
 * @param {import('ethers').Wallet} wallet         Your agent wallet (must have gas)
 * @param {string}                  ledgerAddress  PaymentLedger contract address
 * @param {string}                  rpcUrl         RPC URL from <service>/llms.txt
 * @param {string}                  channelId      Your channel ID (bytes32 hex)
 * @param {bigint}                  cumulativeAmount  Total cumulative amount in RLUSD (18 decimals)
 * @returns {Promise<{ claimId: string, txHash: string }>}
 */
async function redeemVoucher(wallet, ledgerAddress, rpcUrl, channelId, cumulativeAmount) {
  const { ethers } = await _loadEthers();
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const signer = wallet.connect(provider);

  const signature = await signVoucher(signer, ledgerAddress, channelId, cumulativeAmount);

  const contract = new ethers.Contract(ledgerAddress, PAYMENT_LEDGER_ABI, signer);
  const tx = await contract.redeemVoucher({ channelId, cumulativeAmount }, signature);
  const receipt = await tx.wait();

  // Extract claimId from the VoucherRedeemed event (second indexed topic)
  const eventTopic = ethers.id('VoucherRedeemed(bytes32,bytes32,bytes32,bytes32,address,bytes32,address,address,uint256,uint256,uint256)');
  const log = receipt.logs.find(
    (l) => l.address.toLowerCase() === ledgerAddress.toLowerCase() && l.topics[0] === eventTopic,
  );

  return {
    claimId: log ? log.topics[2] : null,
    txHash: receipt.hash,
  };
}

/**
 * Ask the AP4M service to close your payment channel.
 * Works both before and after the channel validBefore cutoff.
 * Before cutoff, the agent wallet signs the close checkpoint automatically.
 *
 * @param {string}                  apiUrl     AP4M service base URL
 * @param {string}                  teamToken  Your team Bearer token
 * @param {import('ethers').Wallet} agentWallet  Your agent wallet (needed before channel cutoff)
 * @param {string} [channelId]  Channel to close; needed when your team has more than one open Channel
 * @returns {Promise<{ tx_hash: string, channel_id: string, final_cumulative_amount: string }>}
 */
async function closeChannel(apiUrl, teamToken, agentWallet, channelId) {
  const { ethers } = await _loadEthers();

  // Step 1: get the checkpoint + typed data from the service
  const query = channelId ? `?channel_id=${encodeURIComponent(channelId)}` : '';
  const challengeResp = await fetch(`${apiUrl}/public/participant/close-channel-challenge${query}`, {
    headers: { 'Authorization': `Bearer ${teamToken}` },
  });
  const challengeData = await challengeResp.json();
  if (!challengeResp.ok) throw new Error(`close-channel-challenge failed (${challengeResp.status}): ${challengeData.error ?? JSON.stringify(challengeData)}`);

  // Step 2: sign the checkpoint with the agent wallet
  const { domain, types, value } = challengeData.typedData;
  // Convert string-serialised bigint fields back to bigint for ethers
  const typedValue = {
    ...value,
    finalCumulativeAmount: BigInt(value.finalCumulativeAmount),
    merchantPspSignerGeneration: BigInt(value.merchantPspSignerGeneration),
    signedAt: BigInt(value.signedAt),
  };
  const rawSig = await agentWallet.signTypedData(domain, types, typedValue);
  const sig = ethers.Signature.from(rawSig);

  // Step 3: submit to service with agent sig components (r + yParityAndS)
  const resp = await fetch(`${apiUrl}/public/participant/close-channel`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${teamToken}`,
    },
    body: JSON.stringify({
      agent_signature_r:  sig.r,
      agent_signature_vs: sig.yParityAndS,
      channel_id: challengeData.checkpoint.channelId,
    }),
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(`close-channel failed (${resp.status}): ${data.error ?? JSON.stringify(data)}`);
  return data;
}

/**
 * Settle a Channel's payments now and wait for the result. The service also settles every
 * payment automatically; this only makes it happen sooner. While a payout waits for
 * confirmation blocks, this polls until it is settled (up to about two minutes).
 *
 * @param {string} apiUrl     AP4M service base URL
 * @param {string} teamToken  Your team Bearer token
 * @param {string} [channelId]  Channel to settle; needed when several Channels have payments
 * @returns {Promise<{ settlement_tx: string, payout_tx: string, amount_rlusd: string, recipient: string, claim_id: string, channel_id: string, claims_settled: number, receipt_url: string | null, receipts: Array<{ claim_id: string, amount_rlusd: string, receipt_url: string | null }> }>}
 *   receipt_url is the path of the latest settled Claim's verifiable receipt on the AP4M service, once it is
 *   published; receipts lists every settled Claim on the Channel with an absolute receipt_url.
 */
async function settle(apiUrl, teamToken, channelId) {
  for (let attempt = 0; ; attempt++) {
    const resp = await fetch(`${apiUrl}/public/participant/settle`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${teamToken}`,
      },
      body: JSON.stringify(channelId ? { channel_id: channelId } : {}),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(`settle failed (${resp.status}): ${data.error ?? JSON.stringify(data)}`);
    if (resp.status !== 202) return data;
    if (attempt >= 40) throw new Error(`settle: payout ${data.payout_tx} is still waiting for confirmations`);
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
}

// Internal: lazy-load ethers
let _ethersCache = null;
async function _loadEthers() {
  if (_ethersCache) return _ethersCache;
  if (typeof require !== 'undefined') {
    _ethersCache = { ethers: require('ethers') };
  } else if (typeof window !== 'undefined' && window.ethers) {
    _ethersCache = { ethers: window.ethers };
  } else {
    _ethersCache = await import('ethers');
  }
  return _ethersCache;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    signIn,
    requestChannel,
  listMerchants,
    listChannels,
    signVoucher,
    redeemVoucher,
    getChannelState,
    closeChannel,
    settle,
    PAYMENT_LEDGER_ABI,
  };
}
