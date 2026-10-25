/**
 * The paid-inference tool, as a plain spec plus a handler.
 *
 * Deliberately framework-free: it holds no Strands, Bedrock or AWS import, so
 * the TR1 agent can wrap it in whatever tool shape it already uses and this
 * package keeps its own dependency list (vendor/ + ethers + @ap4m/sdk). The
 * JSON Schema below is the same shape every tool runtime wants, so wrapping it
 * is a few lines on the caller's side.
 *
 * What the model sees is only the question and the answer. The money is the
 * rail's business: the tool reports what it cost, and refuses rather than
 * overspending, but it never asks the model for permission to pay.
 */
import type { Ask, Receipt } from "./rail.ts";

export const TOOL_NAME = "paid_private_inference";

export const TOOL_SPEC = {
  name: TOOL_NAME,
  description:
    "Ask a question about the masked client documents. The answer is bought from the " +
    "inference merchant with an AP4M payment on the XRPL EVM sidechain, inside a funded " +
    "budget. Returns the answer and what it cost. Use it once per question; it refuses " +
    "rather than exceeding the budget.",
  inputSchema: {
    type: "object",
    properties: {
      question: { type: "string", description: "The question to answer, in plain language." },
      documents: {
        type: "string",
        description: "The masked document text to answer from. Must already be masked; never send raw client data.",
      },
      maxTokens: { type: "integer", minimum: 1, maximum: 4096, description: "Output cap. The price is an upper bound on it." },
    },
    required: ["question"],
    additionalProperties: false,
  },
} as const;

export type ToolInput = { question: string; documents?: string; maxTokens?: number };

export type ToolOutput =
  | {
      ok: true;
      answer: string;
      cost: { rlusd: string; wei: string };
      payment: { transactionHash: string; claimId: string; redemption: string };
      model?: string;
      truncated?: boolean;
    }
  | { ok: false; refused: string; detail?: Record<string, unknown> };

/**
 * Turn a tool call into a gateway request, buy the answer, and report both the
 * answer and the payment. `ask` is the rail's ask(); `nextOperation` must give a
 * fresh name each call, because reusing one returns the earlier purchase.
 */
export function makeToolHandler(options: {
  ask: (input: Ask) => Promise<Receipt>;
  nextOperation: () => string;
  /** The gateway model id to request. Not the pricing key; the merchant prices separately. */
  gatewayModel?: string;
  /** Count of values the privacy service masked, for the data component of the price. */
  maskedFields?: () => number;
}) {
  return async function handle(input: ToolInput): Promise<ToolOutput> {
    const question = String(input.question ?? "").trim();
    if (!question) return { ok: false, refused: "the tool was called with no question" };

    const maxTokens = Number(input.maxTokens ?? 512);
    const content = input.documents ? `${question}\n\nDocuments:\n${input.documents}` : question;
    const request = {
      model: options.gatewayModel ?? "chainaim/auto",
      max_tokens: maxTokens,
      messages: [{ role: "user", content }],
    };

    try {
      const receipt = await options.ask({
        request,
        maskedFields: options.maskedFields?.() ?? 0,
        maxTokens,
        operation: options.nextOperation(),
      });
      const resource = receipt.resource as { answer?: unknown; model?: unknown; truncated?: unknown };
      return {
        ok: true,
        answer: typeof resource.answer === "string" ? resource.answer : JSON.stringify(resource),
        cost: { rlusd: receipt.rlusd, wei: receipt.amountWei },
        payment: { transactionHash: receipt.transactionHash, claimId: receipt.claimId, redemption: receipt.redemption },
        model: typeof resource.model === "string" ? resource.model : undefined,
        truncated: resource.truncated === true ? true : undefined,
      };
    } catch (error) {
      // A refusal is a result, not a crash: the model should be able to say "I
      // could not afford that" and carry on rather than failing the whole run.
      const detail = (error as { detail?: Record<string, unknown> }).detail;
      return { ok: false, refused: (error as Error).message, detail };
    }
  };
}

/** Operation names must be unique per purchase; this makes them readable and sortable. */
export function operationNamer(prefix = "ask"): () => string {
  let n = 0;
  const stamp = new Date().toISOString().replace(/[^0-9]/g, "").slice(2, 12);
  return () => `${prefix}-${stamp}-${String(++n).padStart(3, "0")}`;
}
