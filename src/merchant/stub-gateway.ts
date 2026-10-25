/**
 * A gateway that answers without any ChainAim infrastructure, so the paid x402
 * path can be exercised on its own: the money, the challenge, the redemption and
 * the release are all real, and only the inference is a stand-in.
 *
 * It echoes the last message it was asked, which makes a paid answer
 * recognisable as the answer to that job rather than a canned blob.
 */
import type { Gateway } from "./gateway-client.ts";

export function stubGateway(): Gateway {
  return {
    async healthy(): Promise<boolean> {
      return true;
    },
    async complete(body: string) {
      let asked = body;
      try {
        const parsed = JSON.parse(body) as { messages?: { content?: unknown }[] };
        const last = parsed.messages?.at(-1)?.content;
        if (typeof last === "string") asked = last;
      } catch {
        /* a non-JSON body is echoed as it came */
      }
      return {
        text: `[stub gateway] ${asked.slice(0, 2000)}`,
        model: "stub",
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      };
    },
  };
}
