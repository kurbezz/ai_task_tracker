/** Extracts parser-safe text from legacy and MCP tool-execution results. */
export function normalizeToolOutput(output: unknown): string {
  if (typeof output === "string") return output;
  if (!isRecord(output) || output.isError === true) return "";
  if (typeof output.output === "string") return output.output;
  if (typeof output.content === "string") return output.content;

  if (Array.isArray(output.content)) {
    const text = output.content
      .filter((block): block is Record<string, unknown> => isRecord(block))
      .filter((block) => block.type === "text" && typeof block.text === "string")
      .map((block) => block.text as string)
      .join("\n");
    if (text) return text;
  }

  return normalizeStructuredContent(output.output ?? output.structuredContent);
}

function normalizeStructuredContent(content: unknown): string {
  if (content === undefined) return "";
  if (typeof content === "string") return content;
  try {
    return JSON.stringify(content) ?? "";
  } catch {
    return "";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
