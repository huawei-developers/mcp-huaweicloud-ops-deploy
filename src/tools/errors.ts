import type { CallToolResult, InputRequiredResult, ServerContext, TextContent } from "@modelcontextprotocol/server";

/**
 * Tool handler context — the SDK's ServerContext, directly imported.
 *
 * Importing ServerContext (rather than redefining a structural subset)
 * couples us to the SDK's type surface, but that's the point: if the SDK
 * changes mcpReq's shape, we get a compile error instead of a runtime
 * surprise. The previous structural ToolCtx masked the
 * clientSupportsElicitation gap (P1) — the handler couldn't reach
 * server.getClientCapabilities() because ToolCtx didn't expose the server.
 *
 * Tools that need the server reference (e.g. auth probing client
 * capabilities) receive it at registration time via registerTool's closure,
 * not via ctx.
 */
export type ToolCtx = ServerContext;

/** The union a tool handler may return: a normal result OR an input-required result (§5.3 elicitation). */
export type ToolResult = CallToolResult | InputRequiredResult;

/**
 * A successful tool result: text content (and optional structured content).
 *
 * DESIGN.zh.md §10.1: tools return `content` arrays. `isError` is omitted
 * (defaults to false) on success.
 */
export function ok(text: string, structured?: Record<string, unknown>): CallToolResult {
  const content: TextContent[] = [{ type: "text", text }];
  if (structured !== undefined) {
    return { content, structuredContent: structured };
  }
  return { content };
}

/**
 * A failed tool result: `isError: true` + text content.
 *
 * DESIGN.zh.md §10.1: all tool failures return this shape. The client LLM
 * checks `isError`, reads `content[0].text` for the diagnostic.
 */
export function fail(message: string): CallToolResult {
  return {
    content: [{ type: "text", text: message }],
    isError: true,
  };
}

/**
 * Wrap an async tool handler so thrown errors become `fail()` results
 * instead of propagating as JSON-RPC internal errors.
 *
 * Tool handlers throw for unexpected failures (network, filesystem, bugs).
 * The MCP SDK catches throws and returns a generic error, but we want the
 * error message in `content[0].text` for the LLM to read and act on
 * (§10.2 error classification is driven by message content).
 *
 * The handler may return `InputRequiredResult` (§5.3 elicitation) — that
 * passes through unwrapped, the SDK's input-required seam handles it.
 */
export function guard<TArgs extends Record<string, unknown> | undefined>(
  fn: (args: TArgs, ctx: ToolCtx) => Promise<ToolResult>,
): (args: TArgs, ctx: ToolCtx) => Promise<ToolResult> {
  return async (args, ctx) => {
    try {
      return await fn(args, ctx);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return fail(msg);
    }
  };
}
