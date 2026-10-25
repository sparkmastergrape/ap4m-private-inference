/**
 * AP4M Hackathon x402 toolkit — FOR HACKATHON USE ONLY
 *
 * Pay for and sell resources with HTTP 402 payments on AP4M payment Channels.
 *   - Agent:    buyResource() answers a Merchant's 402 challenge with a signed Voucher.
 *   - Merchant: createX402Merchant() serves one fixed-price resource, redeems each Voucher
 *               on-chain from a wallet you control, and returns the purchased resource.
 *
 * Install (Node.js 22.13 or later):
 *   npm install ethers@6.17.0 <AP4M_API_URL>/sdk/ap4m-sdk.tgz
 *
 * Both sides load the same context from the AP4M service with loadX402Context(), so they
 * agree on the chain, contracts and event window.
 */

import { chmodSync, closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  buildMerchantResourceChallenge, buildX402Challenge, buildX402PaymentPayload, buildX402RedemptionResponse, canonicalJson,
  decodeX402PaymentRequired, decodeX402PaymentResponse, decodeX402PaymentSignature, derivePaymentClaimId,
  encodePaymentVoucherRedemption, encodeX402PaymentRequired, encodeX402PaymentResponse, encodeX402PaymentSignature,
  hashPaymentVoucher, PARTICIPANT_LEDGER_INTERFACE, parseX402PaymentContext, parseX402ResourceUrl, prepareX402Redemption,
  readPublicLogs, requireCanonicalBlock, verifyMerchantResourceRedemption, verifyX402Payment,
} from '@ap4m/sdk';
import {
  parseParticipantRequestContext, readParticipantClaim, readParticipantFinalizedBlock, readParticipantPaymentChannel,
  readPaymentChannelBinding,
} from '@ap4m/sdk/participant-requests';

/**
 * Load and check the x402 context published by the AP4M service.
 * @param {string} apiUrl  AP4M service base URL
 */
export async function loadX402Context(apiUrl) {
  let response;
  try {
    response = await fetch(`${apiUrl}/public/x402-context`, { signal: AbortSignal.timeout(30_000) });
  } catch (error) {
    throw new Error(`x402 context unavailable: ${apiUrl} did not answer (${error.name === 'TimeoutError' ? 'timed out after 30 s' : error.message})`);
  }
  const value = await response.json();
  if (!response.ok) throw new Error(`x402 context unavailable (${response.status}): ${value.error ?? JSON.stringify(value)}`);
  if (value.schemaId !== 'ap4m.hackathon-service.x402-context.v1') throw new Error('unsupported x402 context');
  return Object.freeze({
    network: value.network,
    participantRequest: parseParticipantRequestContext(value.participantRequest),
    x402: parseX402PaymentContext(value.x402),
  });
}

// ── Agent ─────────────────────────────────────────────────────────────────────

function save(file, value) {
  const temporary = file + '.tmp';
  const fd = openSync(temporary, 'wx', 0o600);
  try { writeFileSync(fd, JSON.stringify(value) + '\n'); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temporary, file);
  const directory = openSync(dirname(file), 'r');
  try { fsyncSync(directory); } finally { closeSync(directory); }
}

async function request(url, headers, requestFetch) {
  const response = await requestFetch(url, { headers, redirect: 'error', credentials: 'omit', signal: AbortSignal.timeout(150_000) });
  const chunks = [];
  let length = 0;
  for await (const chunk of response.body) {
    length += chunk.length;
    if (length > 131_072) throw new Error('Merchant response exceeds sample limit');
    chunks.push(chunk);
  }
  return { response, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) };
}

/**
 * Buy one resource from an x402 Merchant with a Voucher on an open Channel.
 *
 * The signed payment is kept in stateDirectory before it is sent, so calling again with
 * the same arguments after a crash or lost response retrieves the same purchase instead
 * of paying twice. Give each different purchase its own operation name.
 *
 * @param {{
 *   context: Awaited<ReturnType<typeof loadX402Context>>,
 *   provider: import('ethers').Provider,
 *   wallet: import('ethers').Wallet,     Agent wallet; it signs the Voucher (no gas needed)
 *   stateDirectory: string,              Directory this Agent owns exclusively
 *   resourceUrl: string,                 Merchant resource URL ending in /resource
 *   channelId: string,                   Open Channel to the Merchant
 *   maximumAmount: string,               Highest price accepted, in token base units (wei)
 *   operation: string,                   Name of this purchase, e.g. "weather-1"
 *   requestFetch?: typeof fetch,
 * }} options
 * @returns {Promise<{ operation: string, claimId: string, transactionHash: string, redemption: 'Confirmed', resource: unknown }>}
 */
export async function buyResource({ context, provider, wallet, stateDirectory, resourceUrl, channelId, maximumAmount, operation, requestFetch = fetch }) {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(operation) || !/^0x[0-9a-f]{64}$/.test(channelId)
    || !/^[1-9][0-9]{0,77}$/.test(maximumAmount)) throw new Error('invalid purchase intent');
  const url = new URL(resourceUrl);
  if (url.href !== resourceUrl || url.username || url.password || url.hash || !['http:', 'https:'].includes(url.protocol)) {
    throw new Error('resource must be a canonical credential-free URL');
  }
  const requestContext = context.participantRequest;
  mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });
  const file = join(stateDirectory, 'purchase.json');
  const intent = { environment: context.x402.merchant.environmentManifestDigest, agent: wallet.address, resourceUrl, channelId, maximumAmount, operation };
  let retained;
  try {
    if (!lstatSync(file).isFile() || lstatSync(file).isSymbolicLink() || lstatSync(file).size > 131_072) throw new Error('invalid retained purchase file');
    retained = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (retained && canonicalJson(retained.intent) !== canonicalJson(intent)) {
    if (!retained.complete) throw new Error('an unresolved purchase must be resumed with its original arguments');
    // Keep the previous signed intent for recovery; never replace an unresolved payment.
    const archived = join(stateDirectory, `purchase-${retained.intent.operation}.json`);
    try {
      const fd = openSync(archived, 'wx', 0o600);
      try { writeFileSync(fd, JSON.stringify(retained) + '\n'); fsyncSync(fd); } finally { closeSync(fd); }
    } catch (error) {
      if (error.code !== 'EEXIST' || canonicalJson(JSON.parse(readFileSync(archived, 'utf8'))) !== canonicalJson(retained)) throw error;
    }
    retained = undefined;
  }
  if (!retained) {
    // Reusing a completed operation name must not buy a second resource.
    const archived = join(stateDirectory, `purchase-${operation}.json`);
    try { retained = JSON.parse(readFileSync(archived, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (retained && canonicalJson(retained.intent) !== canonicalJson(intent)) throw new Error('operation name belongs to another purchase');
  }
  if (!retained) {
    const { response, body } = await request(resourceUrl, { 'X-AP4M-CHANNEL-ID': channelId }, requestFetch);
    // Nothing is signed or retained yet, so the same operation can simply be retried.
    if (response.status === 503 && body?.error === 'chain_head_stale') throw new Error('Merchant is waiting for a new chain block; retry the same operation shortly');
    if (response.status !== 402) throw new Error(`Merchant must return an x402 payment requirement (HTTP ${response.status}: ${body?.error ?? ''})`);
    const required = decodeX402PaymentRequired(response.headers.get('PAYMENT-REQUIRED') ?? '');
    const safe = await readParticipantFinalizedBlock(provider, requestContext);
    const channel = await readParticipantPaymentChannel(provider, requestContext, channelId, safe.number);
    const accepted = required.accepts[0];
    if (required.accepts.length !== 1 || required.resource.url !== resourceUrl || accepted.scheme !== 'batch-settlement'
      || accepted.network !== context.network || accepted.asset !== context.x402.token
      || accepted.payTo !== channel.payout || accepted.extra.ledger !== requestContext.ledger
      || accepted.extra.bindingVersion !== '1' || accepted.extra.pricingMode !== 'fixed' || accepted.extra.channelId !== channelId
      || accepted.extra.acceptedCumulativeAmount !== channel.redeemed || channel.agent !== wallet.address || channel.status !== 1
      || safe.timestamp < channel.validAfter || safe.timestamp >= channel.validBefore - 5
      || BigInt(accepted.amount) > BigInt(maximumAmount) || BigInt(accepted.amount) + BigInt(channel.redeemed) > BigInt(channel.cap)) {
      throw new Error('Merchant challenge exceeds the configured purchase authority');
    }
    await requireCanonicalBlock(provider, safe.number, safe.hash);
    const payload = await buildX402PaymentPayload({ paymentRequired: required, channelId, signer: wallet });
    retained = { schemaId: 'ap4m.hackathon.x402-purchase', intent, header: encodeX402PaymentSignature(payload), previousCumulativeAmount: channel.redeemed, complete: false };
    save(file, retained);
  }
  const payload = decodeX402PaymentSignature(retained.header);
  const voucher = { channelId, cumulativeAmount: BigInt(payload.payload.voucher.cumulativeAmount) };
  const claimId = derivePaymentClaimId(requestContext, voucher, retained.previousCumulativeAmount);
  const { response, body } = await request(resourceUrl, { 'X-AP4M-CHANNEL-ID': channelId, 'PAYMENT-SIGNATURE': retained.header }, requestFetch);
  if (response.status !== 200) throw new Error(`purchase outcome unavailable (HTTP ${response.status}); resume the same operation`);
  const result = decodeX402PaymentResponse(response.headers.get('PAYMENT-RESPONSE') ?? '');
  const transactionHash = result.transaction;
  const [receipt, transaction] = await Promise.all([provider.getTransactionReceipt(transactionHash), provider.getTransaction(transactionHash)]);
  const safe = await readParticipantFinalizedBlock(provider, requestContext);
  const call = encodePaymentVoucherRedemption(requestContext, voucher, payload.payload.agentSignature);
  const claim = await readParticipantClaim(provider, requestContext, claimId, safe.number);
  if (!result.success || result.network !== context.network || !receipt || receipt.status !== 1 || receipt.blockNumber > safe.number
    || !transaction || transaction.to !== call.to || transaction.data !== call.data || transaction.value !== 0n
    || claim.channelId !== channelId || claim.amount !== payload.accepted.amount) throw new Error('Merchant result is not a confirmed exact redemption');
  await requireCanonicalBlock(provider, receipt.blockNumber, receipt.blockHash);
  const events = receipt.logs.flatMap((log) => {
    if (log.address !== call.to) return [];
    try { const event = PARTICIPANT_LEDGER_INTERFACE.parseLog(log); return event?.name === 'VoucherRedeemed' ? [event] : []; } catch { return []; }
  }).filter((event) => event.args.claimId === claimId && event.args.voucherDigest === hashPaymentVoucher(requestContext, voucher));
  if (events.length !== 1) throw new Error('redemption receipt lacks the exact Voucher event');
  await requireCanonicalBlock(provider, safe.number, safe.hash);
  retained.complete = true;
  save(file, retained);
  return { operation, claimId, transactionHash, redemption: 'Confirmed', resource: body.resource };
}

// ── Merchant ──────────────────────────────────────────────────────────────────

/**
 * Start a fixed-price x402 Merchant. GET /resource answers 402 with a payment challenge
 * for the Channel in X-AP4M-CHANNEL-ID, then redeems the Agent's signed Voucher on-chain
 * and returns `content`. Every challenge, payment and result is kept in a SQLite file in
 * stateDirectory, so a retried payment returns the same result and is never redeemed twice.
 *
 * @param {{
 *   context: Awaited<ReturnType<typeof loadX402Context>>,
 *   provider: import('ethers').Provider,
 *   submitter: import('ethers').Signer,  Funded wallet that sends redemptions (needs gas)
 *   stateDirectory: string,              Directory this Merchant owns exclusively
 *   resourceUrl: string,                 Public URL of this Merchant's /resource
 *   merchantParticipantId: string,       Your team's Merchant ID (participant portal)
 *   payout: string,                      Your team's Merchant payout wallet (participant portal)
 *   amount: string,                      Price in token base units (wei)
 *   content: Record<string, unknown>,    The resource sold; a retry receives the same result
 *   cutoffMarginSeconds?: number,        Stop accepting this long before Channel expiry (5-299)
 *   clock?: () => number,                Unix seconds; defaults to the system clock
 * }} config
 * @returns {{ server: import('node:http').Server, close: () => Promise<void> }}  Call server.listen(port)
 */
export function createX402Merchant(config) {
  const cutoffMarginSeconds = config.cutoffMarginSeconds ?? 5;
  const url = new URL(config.resourceUrl);
  parseX402ResourceUrl(config.resourceUrl);
  if (url.pathname !== '/resource' || url.search || url.hash || url.username || url.password || url.href !== config.resourceUrl
    || !['http:', 'https:'].includes(url.protocol)) throw new Error('resourceUrl must be a canonical credential-free HTTP(S) /resource URL');
  if (url.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('public Merchant resources require HTTPS');
  if (!Number.isSafeInteger(cutoffMarginSeconds) || cutoffMarginSeconds < 5 || cutoffMarginSeconds > 299) throw new Error('cutoff margin must be 5 through 299 seconds');
  if (!/^[1-9][0-9]*$/.test(config.amount)) throw new Error('price must be a positive integer in token base units');
  const content = canonicalJson(config.content);
  if (Buffer.byteLength(content) > 65_536) throw new Error('resource exceeds 64 KiB');
  const clock = config.clock ?? (() => Math.floor(Date.now() / 1000));
  // An idle chain's latest block can be older than real time; never issue or accept
  // a payment whose window has already passed in real time.
  const now = (blockTimestamp) => Math.max(blockTimestamp, clock());
  const { context, provider } = config;
  const paymentContext = context.x402;
  const identity = canonicalJson({
    schemaId: 'ap4m.hackathon.x402-merchant-store',
    environment: paymentContext.merchant.environmentManifestDigest,
    resourceUrl: config.resourceUrl, merchantParticipantId: config.merchantParticipantId,
    payout: config.payout, amount: config.amount, content: config.content, cutoffMarginSeconds,
  });
  mkdirSync(config.stateDirectory, { recursive: true, mode: 0o700 });
  if (!lstatSync(config.stateDirectory).isDirectory() || lstatSync(config.stateDirectory).isSymbolicLink()) {
    throw new Error('Merchant state directory must be a real directory');
  }
  chmodSync(config.stateDirectory, 0o700);
  const lockPath = join(config.stateDirectory, 'merchant.lock');
  let lock;
  try {
    lock = openSync(lockPath, 'wx', 0o600);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    throw new Error(`${lockPath} exists: another Merchant is using this state directory, or an earlier run stopped without closing. `
      + 'If no Merchant process is running, delete merchant.lock (never merchant.sqlite) and start again.');
  }
  const dbPath = join(config.stateDirectory, 'merchant.sqlite');
  let db;
  try {
    try { closeSync(openSync(dbPath, 'wx', 0o600)); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    if (!lstatSync(dbPath).isFile() || lstatSync(dbPath).isSymbolicLink()) throw new Error('Merchant store must be a regular file');
    chmodSync(dbPath, 0o600);
    db = new DatabaseSync(dbPath);
    db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS identity (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS challenges (channel_id TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS payments (
        voucher_digest TEXT PRIMARY KEY, channel_id TEXT NOT NULL, value TEXT NOT NULL,
        complete INTEGER NOT NULL DEFAULT 0 CHECK(complete IN (0,1))
      ) STRICT;
      CREATE TABLE IF NOT EXISTS resource_results (voucher_digest TEXT PRIMARY KEY, content TEXT NOT NULL) STRICT;
      CREATE UNIQUE INDEX IF NOT EXISTS pending_channel ON payments(channel_id) WHERE complete=0;`);
    db.prepare('INSERT OR IGNORE INTO identity VALUES (1, ?)').run(identity);
    if (db.prepare('SELECT value FROM identity').get().value !== identity) {
      db.close();
      throw new Error('Merchant store belongs to another configuration; use a new state directory');
    }
  } catch (error) { closeSync(lock); unlinkSync(lockPath); throw error; }
  let queue = Promise.resolve();
  let queued = 0;
  let closing = false;
  const server = createServer({ maxHeaderSize: 16_384 }, (incoming, response) => {
    response.setHeader('Cache-Control', 'no-store, private');
    response.setHeader('Vary', 'PAYMENT-SIGNATURE, X-AP4M-CHANNEL-ID');
    if (closing || queued >= 32) return send(response, 503, { error: 'merchant_busy' });
    if (incoming.method !== 'GET' || incoming.url !== '/resource') return send(response, 404, { error: 'not_found' });
    queued++;
    const work = queue.then(() => handle(incoming, response)).catch(() => {
      send(response, 503, { error: 'payment_pending_or_unavailable', retrySamePayment: true });
    }).finally(() => { queued--; });
    queue = work;
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;

  async function handle(incoming, response) {
    const channelId = header(incoming, 'x-ap4m-channel-id');
    if (!channelId || !/^0x(?!0{64}$)[0-9a-f]{64}$/.test(channelId)) return send(response, 400, { error: 'invalid_channel_id' });
    const paymentHeader = header(incoming, 'payment-signature');
    if (!paymentHeader) {
      const binding = await readPaymentChannelBinding(provider, context.participantRequest, channelId);
      const channel = binding.channel;
      if (!channel || binding.lifecycle !== 'ChannelOpen' || binding.payout?.channelId !== channelId) throw new Error('Channel is not a managed open binding');
      if (channel.merchantId.toLowerCase() !== config.merchantParticipantId.toLowerCase() || channel.payout.toLowerCase() !== config.payout.toLowerCase()) return send(response, 403, { error: 'channel_for_another_merchant' });
      const latest = await provider.getBlock(await provider.getBlockNumber());
      const current = latest ? now(latest.timestamp) : undefined;
      if (current === undefined || current >= channel.validBefore - cutoffMarginSeconds) return send(response, 409, { error: 'merchant_acceptance_closed' });
      if (db.prepare('SELECT 1 FROM payments WHERE channel_id=? AND complete=0').get(channelId)) return send(response, 409, { error: 'retry_retained_payment' });
      const existing = db.prepare('SELECT value FROM challenges WHERE channel_id=?').get(channelId);
      let challenge = existing ? JSON.parse(String(existing.value)) : undefined;
      if (!challenge || challenge.value.previousCumulativeAmount !== channel.redeemed
        || current >= challenge.value.validBefore - cutoffMarginSeconds) {
        // x402 limits the window to 300 seconds after the challenge block. When the
        // latest block is older than that window, wait for a new block instead of
        // issuing a challenge that has already expired.
        const validBefore = Math.min(channel.validBefore, paymentContext.validBefore, binding.chainTimestamp + 300);
        if (current >= validBefore - cutoffMarginSeconds) {
          response.setHeader('Retry-After', '15');
          return send(response, 503, { error: 'chain_head_stale', retryAfterSeconds: 15 });
        }
        if (!existing && Number(db.prepare('SELECT count(*) AS n FROM challenges').get().n) >= 1024) return send(response, 503, { error: 'merchant_capacity_reached' });
        challenge = await buildMerchantResourceChallenge(provider, paymentContext.merchant, {
          channelId, merchantParticipantId: config.merchantParticipantId, payout: config.payout, amount: config.amount,
          resource: { uri: config.resourceUrl, description: 'AP4M hackathon resource', mimeType: 'application/json' },
          validBefore,
        });
        db.prepare('INSERT INTO challenges VALUES (?,?) ON CONFLICT(channel_id) DO UPDATE SET value=excluded.value').run(channelId, canonicalJson(challenge));
      }
      response.setHeader('PAYMENT-REQUIRED', encodeX402PaymentRequired(buildX402Challenge(paymentContext, challenge.value, challenge.digest)));
      return send(response, 402, { x402Version: 2, error: 'payment_required' });
    }
    let normalized;
    try { normalized = encodeX402PaymentSignature(decodeX402PaymentSignature(paymentHeader)); } catch { return send(response, 400, { error: 'invalid_payment' }); }
    const payload = decodeX402PaymentSignature(normalized);
    if (payload.accepted.extra.channelId !== channelId) return send(response, 400, { error: 'wrong_channel' });
    if (payload.accepted.extra.pricingMode !== 'fixed' || !('cumulativeAmount' in payload.payload.voucher)) return send(response, 400, { error: 'fixed_pricing_required' });
    const requestedDigest = hashPaymentVoucher(paymentContext.merchant, {
      channelId: payload.payload.voucher.channelId, cumulativeAmount: BigInt(payload.payload.voucher.cumulativeAmount),
    });
    // The resource signature is part of the retained envelope. A conflicting
    // envelope cannot reuse the same Voucher to retrieve a different result.
    const row = db.prepare('SELECT voucher_digest,value,complete FROM payments WHERE voucher_digest=?').get(requestedDigest);
    let retained;
    let replay = false;
    let voucherDigest;
    if (row && JSON.parse(String(row.value)).header === normalized) {
      retained = JSON.parse(String(row.value));
      voucherDigest = row.voucher_digest;
      replay = true;
    } else {
      const issued = db.prepare('SELECT value FROM challenges WHERE channel_id=?').get(channelId);
      if (!issued) return send(response, 409, { error: 'request_challenge_first' });
      const challenge = JSON.parse(String(issued.value));
      const head = await provider.getBlock(await provider.getBlockNumber());
      // Refuse before submitting: a redemption mined after this deadline still moves funds.
      if (!head || now(head.timestamp) >= challenge.value.validBefore - cutoffMarginSeconds) return send(response, 409, { error: 'merchant_acceptance_closed' });
      let plan;
      try { plan = await prepareX402Redemption(provider, paymentContext, challenge.value, challenge.digest, normalized); } catch { return send(response, 400, { error: 'invalid_payment' }); }
      voucherDigest = plan.payment.voucherDigest;
      if (db.prepare('SELECT 1 FROM payments WHERE voucher_digest=? OR (channel_id=? AND complete=0)').get(voucherDigest, channelId)) return send(response, 409, { error: 'payment_conflict' });
      if (Number(db.prepare('SELECT count(*) AS n FROM payments').get().n) >= 10_000) return send(response, 503, { error: 'merchant_capacity_reached' });
      retained = { challenge, header: normalized, transactionHash: null };
      // Persist before sending the redemption. An unknown outcome is reconciled on retry,
      // never blindly rebroadcast.
      db.prepare('INSERT INTO payments(voucher_digest,channel_id,value) VALUES (?,?,?)').run(voucherDigest, channelId, canonicalJson(retained));
      try {
        retained.transactionHash = (await config.submitter.sendTransaction({ to: plan.transaction.to, data: plan.transaction.data, value: 0n })).hash;
        db.prepare('UPDATE payments SET value=? WHERE voucher_digest=?').run(canonicalJson(retained), voucherDigest);
      } catch { /* Reconcile a lost submission response through canonical events below. */ }
    }
    const payment = verifyX402Payment(paymentContext, retained.challenge.value, retained.challenge.digest, retained.header);
    let transactionHash = retained.transactionHash;
    if (replay || !transactionHash) {
      const claimId = derivePaymentClaimId(paymentContext.merchant, {
        channelId: payment.voucher.channelId, cumulativeAmount: BigInt(payment.voucher.cumulativeAmount),
      }, retained.challenge.value.previousCumulativeAmount);
      const safe = await readParticipantFinalizedBlock(provider, context.participantRequest);
      const event = PARTICIPANT_LEDGER_INTERFACE.getEvent('VoucherRedeemed');
      const logs = await readPublicLogs(provider, {
        address: paymentContext.merchant.ledger, topics: [event.topicHash, channelId, claimId],
        fromBlock: retained.challenge.value.finalityBlockNumber, toBlock: safe.number,
      });
      if (logs.length !== 1) throw new Error('redemption outcome is not confirmed');
      transactionHash = logs[0].transactionHash;
    }
    // Recheck canonical evidence even for a completed retry; a persisted success is not a
    // substitute for chain finality after a reorganization. A payment retained and submitted
    // before its deadline still delivers what was paid for when its block is late.
    const result = await verifyMerchantResourceRedemption(provider, paymentContext.merchant,
      retained.challenge.value, retained.challenge.digest, payment, transactionHash, { acceptLateInclusion: true });
    if (retained.transactionHash !== transactionHash) {
      retained.transactionHash = transactionHash;
      db.prepare('UPDATE payments SET value=? WHERE voucher_digest=?').run(canonicalJson(retained), voucherDigest);
    }
    const existingResource = db.prepare('SELECT content FROM resource_results WHERE voucher_digest=?').get(voucherDigest);
    const resourceContent = existingResource ? String(existingResource.content) : content;
    if (!existingResource) db.prepare('INSERT INTO resource_results VALUES (?,?)').run(voucherDigest, resourceContent);
    db.prepare('UPDATE payments SET complete=1 WHERE voucher_digest=?').run(voucherDigest);
    response.setHeader('PAYMENT-RESPONSE', encodeX402PaymentResponse(buildX402RedemptionResponse(result, context.network)));
    if (replay) response.setHeader('Idempotency-Replayed', 'true');
    send(response, 200, { resource: JSON.parse(resourceContent), redemption: result });
  }

  return {
    server,
    async close() {
      if (closing) return;
      closing = true;
      const closed = new Promise((resolve, reject) => {
        if (!server.listening) return resolve();
        server.close((error) => error ? reject(error) : resolve());
      });
      await queue;
      await closed;
      db.close(); closeSync(lock); unlinkSync(lockPath);
    },
  };
}

function header(incoming, name) {
  if (incoming.rawHeaders.filter((_, i) => i % 2 === 0 && incoming.rawHeaders[i].toLowerCase() === name).length > 1) throw new Error('duplicate header');
  const value = incoming.headers[name];
  if (value !== undefined && typeof value !== 'string') throw new Error('invalid header');
  return value;
}

function send(response, status, body) {
  if (response.destroyed || response.writableEnded) return;
  const encoded = JSON.stringify(body);
  response.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(encoded) });
  response.end(encoded);
}
