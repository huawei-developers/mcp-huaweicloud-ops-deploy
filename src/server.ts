import { McpServer, SUPPORTED_PROTOCOL_VERSIONS } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";

import { registerAllTools } from "./tools/index.js";
import { registerTaskHandlers } from "./tasks/handlers.js";
import { SERVER_INSTRUCTIONS } from "./instructions.js";
import { SERVER_VERSION } from "./version.js";

export const SERVER_NAME = "huaweicloud-ops-deploy";
export { SERVER_VERSION };

/**
 * Build the McpServer instance.
 *
 * ## Protocol era: legacy (2025-11-25) only
 *
 * The server deliberately declares support for the legacy protocol era only,
 * not the modern 2026-07-28 revision. The reason is the Tasks extension.
 *
 * Six terraform tools (install/init/plan/apply/destroy/refresh) return
 * `CreateTaskResult` handles that the client polls via `tasks/get` and cancels
 * via `tasks/cancel` — terraform operations run minutes to tens of minutes,
 * so synchronous blocking is not viable. In MCP SDK 2.0.0, Tasks work
 * completely on the legacy era but are unusable on the modern era:
 *
 *   1. `tools/call` returning `resultType: "task"` is rejected by the modern
 *      codec's `decodeResult` (src-CX2iR2pK.mjs:4105) — it accepts only
 *      `"complete"` and `"input_required"`.
 *   2. `tasks/get` and `tasks/cancel` are rejected by the modern era's
 *      inbound era-gate (`_onrequest`, src-CX2iR2pK.mjs:6397) because they
 *      sit in the legacy spec method registry and the modern codec treats
 *      them as deleted spec methods, not era-blind extension methods.
 *
 * The modern era's only async mechanism, `input_required`, is for mid-flight
 * user input (elicitation), not background long-running work — wrong
 * semantics for terraform. So Tasks and 2026-07-28 are mutually exclusive
 * under SDK 2.0.0. When the SDK ships real `io.modelcontextprotocol/tasks`
 * extension support on the modern era (poll-based `tasks/get` + `tasks/update`
 * per SEP-2663, era-blind dispatch), this can be revisited.
 *
 * ## Tasks capability: extension, not core field
 *
 * Per the 2026-07-28 spec, Tasks moved out of the core capability set into
 * the `io.modelcontextprotocol/tasks` extension. We advertise it under
 * `extensions` (not the deprecated core `tasks` field). The 2025-era
 * `ServerCapabilities` schema also has an `extensions` field, so legacy
 * clients see the extension advertisement. Clients that opt into the
 * extension in their per-request `_meta` may receive `CreateTaskResult`
 * from the long-running tools and poll them via `tasks/get`.
 */
export function createServer(): McpServer {
  const mcp = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      capabilities: {
        tools: {},
        // Advertise the tasks extension (v2 / 2026-07-28 spec). Tasks moved
        // out of the core capability set into the io.modelcontextprotocol/tasks
        // extension. Clients that declare tasks support (via initialize
        // capabilities in legacy era, or the extension in modern era) receive
        // task handles from long-running tools and poll via tasks/get. Clients
        // without it get synchronous execution with progress notifications
        // (see launchTaskResult in terraform.ts).
        // We serve legacy era only (SDK 2.0's modern era rejects task RPCs),
        // but the extensions field is present in both era capability schemas,
        // so this is visible to clients on either era.
        extensions: {
          "io.modelcontextprotocol/tasks": {},
        },
      },
      instructions: SERVER_INSTRUCTIONS,
      // Legacy era only. See the method comment for why 2026-07-28 is not
      // declared: SDK 2.0.0's modern era rejects task creation and task RPCs.
      supportedProtocolVersions: [...SUPPORTED_PROTOCOL_VERSIONS],
    },
  );

  registerTaskHandlers(mcp.server);
  registerAllTools(mcp);

  return mcp;
}

/**
 * Start the server over stdio and run until the transport closes.
 *
 * MCP clients spawn this process as a child and communicate over
 * stdin/stdout. Logs go to stderr (stdout is reserved for JSON-RPC).
 *
 * Uses `serveStdio` rather than the bare `StdioServerTransport`. `serveStdio`
 * owns the opening-exchange classification (it inspects the first request's
 * `_meta` envelope, decides the era, and pins one server instance for the
 * connection lifetime). We serve legacy only today, and the bare transport
 * would work for legacy — but `serveStdio` is the canonical entry the SDK
 * documents for stdio serving, handles both eras correctly, and lets us
 * re-enable the modern era later without touching the entry point.
 */
export async function main(): Promise<void> {
  serveStdio(() => createServer());
  // serveStdio starts the transport internally; the stdin listener keeps the
  // Node event loop alive. Resolve main() when stdin closes so callers that
  // await main() exit cleanly once the client disconnects.
  await new Promise<void>((resolve) => {
    process.stdin.on("close", () => resolve());
    process.stdin.on("end", () => resolve());
  });
}
