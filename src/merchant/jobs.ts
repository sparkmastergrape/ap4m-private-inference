/**
 * The merchant's store. Keeps the kit merchant's tables exactly
 * (challenges / payments / resource_results, with the one-pending-payment-per-
 * channel index) and adds `jobs`: the staged masked request and its quote.
 *
 * Why a job table at all: the x402 hot path is GET /resource with headers only
 * and no body, so the masked request is staged by a free POST /jobs first and
 * referenced by id in a header. See DESIGN/xrplh-18 section 4.
 *
 * Nothing here stores document text in a log. The masked request IS stored,
 * because the merchant must send exactly what was quoted and recount it on
 * retry; it is masked before it ever arrives.
 */
import { DatabaseSync } from "node:sqlite";
import { chmodSync, closeSync, lstatSync, mkdirSync, openSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export type Job = {
  jobId: string;
  channelId: string;
  /** The masked request body that will be sent to the gateway, verbatim. */
  request: string;
  /** The challenge amount for this job, in token base units. */
  quoteWei: string;
  /** The ceiling frozen when the job was made; the agent must reuse it (section 0.3). */
  maximumAmount: string;
  /** What the quote was built from, for the receipt. */
  breakdown: string;
  createdAt: number;
  expiresAt: number;
  /** Set once a voucher has been accepted for this job, so it cannot be bought twice. */
  voucherDigest: string | null;
};

export class JobStore {
  #db: DatabaseSync;
  #lock: number;
  #lockPath: string;

  constructor(stateDirectory: string, identity: string) {
    mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });
    const stat = lstatSync(stateDirectory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("merchant state directory must be a real directory");
    chmodSync(stateDirectory, 0o700);

    this.#lockPath = join(stateDirectory, "merchant.lock");
    try {
      this.#lock = openSync(this.#lockPath, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      throw new Error(
        `${this.#lockPath} exists: another merchant is using this state directory, or an earlier run stopped without closing. ` +
          "If no merchant process is running, delete merchant.lock (never merchant.sqlite) and start again.",
      );
    }

    const dbPath = join(stateDirectory, "merchant.sqlite");
    try {
      try {
        closeSync(openSync(dbPath, "wx", 0o600));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      const dbStat = lstatSync(dbPath);
      if (!dbStat.isFile() || dbStat.isSymbolicLink()) throw new Error("merchant store must be a regular file");
      chmodSync(dbPath, 0o600);
      this.#db = new DatabaseSync(dbPath);
      this.#db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
        CREATE TABLE IF NOT EXISTS identity (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL) STRICT;
        CREATE TABLE IF NOT EXISTS challenges (channel_id TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
        CREATE TABLE IF NOT EXISTS payments (
          voucher_digest TEXT PRIMARY KEY, channel_id TEXT NOT NULL, value TEXT NOT NULL,
          complete INTEGER NOT NULL DEFAULT 0 CHECK(complete IN (0,1))
        ) STRICT;
        CREATE TABLE IF NOT EXISTS resource_results (voucher_digest TEXT PRIMARY KEY, content TEXT NOT NULL) STRICT;
        CREATE UNIQUE INDEX IF NOT EXISTS pending_channel ON payments(channel_id) WHERE complete=0;
        CREATE TABLE IF NOT EXISTS jobs (
          job_id TEXT PRIMARY KEY, channel_id TEXT NOT NULL, request TEXT NOT NULL,
          quote_wei TEXT NOT NULL, maximum_amount TEXT NOT NULL, breakdown TEXT NOT NULL,
          created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, voucher_digest TEXT
        ) STRICT;
        CREATE INDEX IF NOT EXISTS jobs_by_channel ON jobs(channel_id);`);
      this.#db.prepare("INSERT OR IGNORE INTO identity VALUES (1, ?)").run(identity);
      const held = this.#db.prepare("SELECT value FROM identity").get() as { value: string };
      if (held.value !== identity) {
        this.#db.close();
        throw new Error("merchant store belongs to another configuration; use a new state directory");
      }
    } catch (error) {
      closeSync(this.#lock);
      unlinkSync(this.#lockPath);
      throw error;
    }
  }

  get db(): DatabaseSync {
    return this.#db;
  }

  createJob(input: Omit<Job, "jobId" | "createdAt" | "voucherDigest">): Job {
    const job: Job = { ...input, jobId: randomUUID(), createdAt: Math.floor(Date.now() / 1000), voucherDigest: null };
    this.#db
      .prepare(
        "INSERT INTO jobs(job_id,channel_id,request,quote_wei,maximum_amount,breakdown,created_at,expires_at,voucher_digest) VALUES (?,?,?,?,?,?,?,?,NULL)",
      )
      .run(job.jobId, job.channelId, job.request, job.quoteWei, job.maximumAmount, job.breakdown, job.createdAt, job.expiresAt);
    return job;
  }

  job(jobId: string): Job | undefined {
    const row = this.#db.prepare("SELECT * FROM jobs WHERE job_id=?").get(jobId) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return {
      jobId: String(row.job_id),
      channelId: String(row.channel_id),
      request: String(row.request),
      quoteWei: String(row.quote_wei),
      maximumAmount: String(row.maximum_amount),
      breakdown: String(row.breakdown),
      createdAt: Number(row.created_at),
      expiresAt: Number(row.expires_at),
      voucherDigest: row.voucher_digest === null ? null : String(row.voucher_digest),
    };
  }

  /** Bind a job to the voucher that paid for it, so the same job cannot be bought twice. */
  bindJob(jobId: string, voucherDigest: string): void {
    this.#db.prepare("UPDATE jobs SET voucher_digest=? WHERE job_id=?").run(voucherDigest, jobId);
  }

  jobForVoucher(voucherDigest: string): Job | undefined {
    const row = this.#db.prepare("SELECT job_id FROM jobs WHERE voucher_digest=?").get(voucherDigest) as { job_id: string } | undefined;
    return row ? this.job(row.job_id) : undefined;
  }

  /** How many jobs are staged, so the merchant can refuse rather than grow without bound. */
  jobCount(): number {
    return Number((this.#db.prepare("SELECT count(*) AS n FROM jobs").get() as { n: number }).n);
  }

  /** Drop jobs that expired and were never paid for. Returns how many went. */
  pruneExpired(now = Math.floor(Date.now() / 1000)): number {
    const result = this.#db.prepare("DELETE FROM jobs WHERE voucher_digest IS NULL AND expires_at < ?").run(now);
    return Number(result.changes);
  }

  close(): void {
    this.#db.close();
    closeSync(this.#lock);
    try {
      unlinkSync(this.#lockPath);
    } catch {
      /* already gone */
    }
  }
}
