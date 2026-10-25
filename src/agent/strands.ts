/**
 * The paid-inference tool inside a Strands agent on Amazon Bedrock.
 *
 * The model sees only the question and the MASKED answer. The masked document
 * is held here, in the process, and is never passed through the model: the tool
 * adds it to the paid request itself. The placeholder map is not in this file at
 * all; main.ts restores the real values after the run, on this computer.
 *
 * This lives in hack/ap4m on purpose. The boundary rule stops this package from
 * importing services/paywall (whose own agent is the L1 rail), so the same SDK
 * is used here as a plain npm dependency.
 */
import { Agent, BedrockModel, tool } from "@strands-agents/sdk";
import { z } from "zod";
import { TOOL_NAME, type ToolInput, type ToolOutput } from "./tool.ts";

export type StrandsOptions = {
  handler: (input: ToolInput) => Promise<ToolOutput>;
  /** Already masked. Held here; never shown to the model. */
  documents?: string;
  question: string;
  maxTokens: number;
  region: string;
  modelId: string;
};

export type StrandsResult = {
  /** What the tool returned, or undefined if the model never called it. */
  tool?: ToolOutput;
  /** How many times the model called the tool. More than one means more than one payment. */
  calls: number;
  /** The agent's own closing words. They are about the masked answer, never the real values. */
  reply: string;
};

export async function runStrandsAgent(options: StrandsOptions): Promise<StrandsResult> {
  const seen: { calls: number; last?: ToolOutput } = { calls: 0 };

  const paidAsk = tool({
    name: TOOL_NAME,
    description:
      "Ask the paid private-inference service a question about the user's document. " +
      "The document is attached for you and masked; you never see it. This costs RLUSD, " +
      "so call it once. It returns the answer with personal details as placeholders, and the cost.",
    inputSchema: z.object({
      question: z.string().min(1).max(2000).describe("The question, in plain language, with no personal details in it."),
    }),
    callback: async (input) => {
      seen.calls++;
      // A second call would be a second payment: refuse it here, not by asking the model nicely.
      if (seen.calls > 1) return { ok: false, refused: "already asked once this run; do not call this tool again" };
      const result = await options.handler({ question: input.question, documents: options.documents, maxTokens: options.maxTokens });
      seen.last = result;
      return result;
    },
  });

  const agent = new Agent({
    model: new BedrockModel({ region: options.region, modelId: options.modelId, maxTokens: 512 }),
    tools: [paidAsk],
    systemPrompt:
      `You help a user with one document. Call ${TOOL_NAME} exactly once with the user's question, ` +
      "then tell the user the answer in a sentence or two. Names and numbers in the answer appear as " +
      "placeholders like <C_PERSON_1>; keep them exactly as written. If the tool refuses, say so and why.",
    toolExecutor: "sequential",
    printer: false,
  });

  const result = await agent.invoke(options.question, { limits: { turns: 4 } });
  return { tool: seen.last, calls: seen.calls, reply: result.toString() };
}
