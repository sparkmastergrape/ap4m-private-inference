/**
 * Input token counting for the quote. Two sources:
 *
 *   chars   - utf8 bytes divided by charsPerToken, plus inputMargin. Always available.
 *   bedrock - Amazon Bedrock CountTokens: free, and documented to match the count
 *             that would be charged. Not every model supports it, so a failure
 *             falls back to chars rather than refusing the job.
 *
 * Output length cannot be predicted by any production API, so the quote uses the
 * requested max_tokens as an upper bound. See DESIGN/xrplh-18 7.
 */

export type CountSource = "chars" | "bedrock";

export type CountResult = {
  /** Undefined means "count by size instead"; estimate() handles that. */
  inputTokens?: number;
  source: "counted" | "bytes";
  /** Set when a bedrock count was asked for and could not be produced. */
  note?: string;
};

export function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/**
 * Count by size. No network, no SDK, no model support needed.
 */
export function countByChars(): CountResult {
  return { source: "bytes" };
}

/**
 * Ask Bedrock for the exact input count. `invoke` is injected so this file stays
 * free of the AWS SDK and testable without credentials; the merchant and the
 * agent pass the same real implementation.
 *
 * Any failure is reported as a note and counted by size instead: a quote must
 * never fail because a token counter was unavailable.
 */
export async function countWithBedrock(
  body: unknown,
  invoke: (body: unknown) => Promise<number>,
): Promise<CountResult> {
  try {
    const inputTokens = await invoke(body);
    if (!Number.isInteger(inputTokens) || inputTokens < 0) {
      return { source: "bytes", note: `CountTokens returned ${inputTokens}; counted by size instead` };
    }
    return { inputTokens, source: "counted" };
  } catch (error) {
    return { source: "bytes", note: `CountTokens unavailable (${(error as Error).message}); counted by size instead` };
  }
}

export async function count(
  source: CountSource,
  body: unknown,
  invoke?: (body: unknown) => Promise<number>,
): Promise<CountResult> {
  if (source === "bedrock") {
    if (!invoke) return { source: "bytes", note: "no CountTokens caller was provided; counted by size instead" };
    return countWithBedrock(body, invoke);
  }
  return countByChars();
}
