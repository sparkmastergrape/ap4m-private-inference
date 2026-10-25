/**
 * The one and only way this merchant reaches ChainAim's inference. HTTP, over
 * the wire, nothing imported: `services/gateway` is a separate service with its
 * own tests and its own lifecycle, and `hack/ap4m` must not depend on its code
 * (the boundary rule in AGENTS.md, enforced by scripts/check-boundaries.mjs).
 *
 * Routes used, from services/gateway/src/server.ts:
 *   GET  /healthz                unauthenticated, reports the privacy scanner
 *   POST /v1/chat/completions    Authorization: Bearer <gateway key>
 *
 * A stub gateway only has to answer those two the same way, which is what the
 * tests use.
 */

export class GatewayError extends Error {
  /** HTTP status the merchant should answer with. 502 unless the gateway refused the input. */
  status: number;
  /** The gateway's own status, when it answered at all. */
  upstreamStatus?: number;

  constructor(message: string, status = 502, upstreamStatus?: number) {
    super(message);
    this.name = "GatewayError";
    this.status = status;
    this.upstreamStatus = upstreamStatus;
  }
}

export type GatewayAnswer = {
  /** The assistant text, pulled out of the OpenAI-shaped body for the resource payload. */
  text: string;
  /** Whatever the gateway reported it used, for the receipt. Absent if it reported nothing. */
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  /** The model that actually answered, which may differ from the one asked for. */
  model?: string;
  /** The gateway's decision id, when it set the header, so a receipt can be traced to a routing decision. */
  decisionId?: string;
};

export type Gateway = {
  healthy(): Promise<boolean>;
  complete(body: string, timeoutMs: number): Promise<GatewayAnswer>;
};

/** Pull the assistant text out of an OpenAI-shaped completion. */
export function answerText(parsed: unknown): string {
  const choices = (parsed as { choices?: unknown })?.choices;
  if (!Array.isArray(choices) || !choices.length) throw new GatewayError("the gateway returned no choices");
  const message = (choices[0] as { message?: { content?: unknown }; text?: unknown })?.message;
  const content = message?.content ?? (choices[0] as { text?: unknown })?.text;
  if (typeof content === "string") return content;
  // Some models answer with content parts rather than a plain string.
  if (Array.isArray(content)) {
    const joined = content
      .map((part) => (typeof part === "string" ? part : typeof (part as { text?: unknown })?.text === "string" ? (part as { text: string }).text : ""))
      .join("");
    if (joined) return joined;
  }
  throw new GatewayError("the gateway returned a choice with no text");
}

export function httpGateway(baseUrl: string, apiKey: string): Gateway {
  const root = baseUrl.replace(/\/+$/, "");
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;

  return {
    async healthy(): Promise<boolean> {
      try {
        const response = await fetch(`${root}/healthz`, { signal: AbortSignal.timeout(5_000) });
        return response.ok;
      } catch {
        return false;
      }
    },

    async complete(body: string, timeoutMs: number): Promise<GatewayAnswer> {
      let response: Response;
      try {
        response = await fetch(`${root}/v1/chat/completions`, {
          method: "POST",
          headers,
          body,
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        const reason = (error as Error).name === "TimeoutError" ? `did not answer within ${timeoutMs}ms` : (error as Error).message;
        throw new GatewayError(`the gateway ${reason}`);
      }

      const text = await response.text();
      if (!response.ok) {
        // 400 and 401 are about the request we sent, not a gateway outage; they
        // still mean no answer, so the voucher must not be redeemed either way.
        throw new GatewayError(
          `the gateway answered HTTP ${response.status}: ${text.slice(0, 400)}`,
          502,
          response.status,
        );
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new GatewayError("the gateway did not answer with JSON");
      }

      const usage = (parsed as { usage?: GatewayAnswer["usage"] })?.usage;
      return {
        text: answerText(parsed),
        usage: usage ?? undefined,
        model: typeof (parsed as { model?: unknown })?.model === "string" ? (parsed as { model: string }).model : undefined,
        decisionId: response.headers.get("x-chainaim-decision-id") ?? undefined,
      };
    },
  };
}
