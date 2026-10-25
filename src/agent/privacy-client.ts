/**
 * The agent's door to the privacy service: read a document, mask it, and put the
 * real values back after the answer comes home.
 *
 * HTTP only, by the boundary rule in AGENTS.md: services/client-privacy is a
 * separate service with its own tests, and hack/ap4m must not import its code.
 * It listens on loopback and refuses any other bind address, so nothing here
 * travels off this computer.
 *
 * THE RULE THIS FILE EXISTS TO KEEP: the placeholder map never leaves this
 * process. The merchant receives masked text. The gateway receives masked text.
 * The model receives masked text. Only `restore` sees the map, and it runs
 * against the loopback service on this computer, after the answer is paid for.
 * `MaskedDocument.map` is therefore never put in a request to the merchant, in
 * the ledger, or in a log line.
 */

export class PrivacyError extends Error {
  status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "PrivacyError";
    this.status = status;
  }
}

export type MaskedDocument = {
  /** Safe to send: every detected value has become a placeholder. */
  masked: string;
  /** NEVER SEND THIS. Placeholder to original value, for local restoration only. */
  map: Record<string, string>;
  /** How many of each entity type were found. Counts, never values. */
  counts: Record<string, number>;
  /** Card numbers are deleted outright rather than mapped, so they cannot come back. */
  cardsRemoved: number;
  /** What the quote's data component is charged on: how many values were replaced. */
  maskedFields: number;
};

export type Privacy = {
  extract(file: string): Promise<{ type: string; text: string }>;
  mask(text: string): Promise<MaskedDocument>;
  scan(text: string): Promise<{ counts: Record<string, number>; total: number }>;
  restore(text: string, map: Record<string, string>): Promise<{ text: string; unresolved: number }>;
};

export function httpPrivacy(baseUrl = "http://127.0.0.1:8787", timeoutMs = 30_000): Privacy {
  const root = baseUrl.replace(/\/+$/, "");

  async function call<T>(path: string, body: unknown): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${root}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new PrivacyError(
        `the privacy service at ${root} did not answer: ${(error as Error).message}. ` +
          "Start it with: node services/client-privacy/src/main.ts",
      );
    }
    const text = await response.text();
    if (!response.ok) throw new PrivacyError(`${path} answered HTTP ${response.status}: ${text.slice(0, 300)}`, response.status);
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new PrivacyError(`${path} did not answer with JSON`);
    }
  }

  return {
    extract(file) {
      return call("/extract", { file });
    },

    async mask(text) {
      const result = await call<{ masked: string; map: Record<string, string>; counts: Record<string, number>; cardsRemoved: number }>(
        "/mask",
        { text },
      );
      // One placeholder per distinct value replaced, plus the cards that were
      // deleted rather than mapped: that is what the merchant prices on.
      const maskedFields = Object.keys(result.map).length + result.cardsRemoved;
      return { ...result, maskedFields };
    },

    scan(text) {
      return call("/scan", { text });
    },

    restore(text, map) {
      return call("/restore", { text, map });
    },
  };
}

/**
 * Refuse to send anything that still holds a known original value.
 *
 * Masking is detection, and detection misses things. This is the last check
 * before a document is handed to a merchant that will forward it to a model, so
 * it compares the outgoing text against the values we know about rather than
 * trusting that masking caught them. It cannot find what was never detected, so
 * it is a backstop, not a guarantee.
 */
export function assertMasked(outgoing: string, map: Record<string, string>): void {
  const leaked = Object.values(map).filter((value) => value.length > 3 && outgoing.includes(value));
  if (leaked.length) {
    throw new PrivacyError(
      `refusing to send: the masked text still contains ${leaked.length} original value(s) that masking had replaced`,
    );
  }
}
