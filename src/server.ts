import { McpServer, SUPPORTED_PROTOCOL_VERSIONS, createMcpHandler } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { toNodeHandler, localhostHostValidation, localhostOriginValidation } from "@modelcontextprotocol/node";
import { createServer as createHttpServer } from "node:http";

import { registerAllTools } from "./tools/index.js";
import { registerTaskHandlers } from "./tasks/handlers.js";
import { registerPermissionMethods } from "./permission/methods.js";
import { registerCredentialMethods } from "./credential/methods.js";
import { getMode } from "./permission/mode.js";
import { registryStatus } from "./permission/registry.js";
import { SCOPE } from "./auth/store.js";
import { SERVER_INSTRUCTIONS } from "./instructions.js";
import { SERVER_VERSION } from "./version.js";

export const SERVER_NAME = "huaweicloud-ops-deploy";
export { SERVER_VERSION };

/**
 * Build the McpServer instance.
 *
 * ## Protocol eras: 2025 legacy and 2026-07-28 modern, both served
 *
 * The server serves whichever era the client negotiates. `serveStdio`'s
 * opening-exchange classifier inspects the first request for a modern
 * `_meta` envelope claim (io.modelcontextprotocol/protocolVersion) and pins
 * one server instance per connection accordingly — it does NOT consult this
 * server's `supportedProtocolVersions` list, so that field does not gate the
 * era. A client that sends a 2026-07-28 envelope is served on the modern
 * era; a legacy `initialize` is served on 2025. Both paths work.
 *
 * ## Tasks extension: advertised, but the task result path is broken in SDK 2.0.0
 *
 * Six terraform tools (install/init/plan/apply/destroy/refresh) run minutes to
 * tens of minutes, so synchronous blocking is not viable. The tasks extension
 * (`io.modelcontextprotocol/tasks`) is advertised, and `tasks/get` +
 * `tasks/cancel` handlers are registered on the low-level Server
 * (tasks/handlers.ts). The modern era-gate dispatches `tasks/get` (it sits in
 * `requestMethodKeys`, so `codec.hasRequestMethod` returns true).
 *
 * BUT the task *result* path from `tools/call` is broken under SDK 2.0.0 on
 * both eras, so `launchTaskResult` does not use it today:
 *
 *   - The SDK has no task runtime. `CreateTaskResult` is `@deprecated
 *     "2025-11-25 wire vocabulary with no SDK runtime"` — its schema is
 *     `ResultSchema.extend({ task: TaskSchema })` (a top-level `task` field),
 *     not the `structuredContent.resultType: "task"` shape `taskToResult`
 *     produces.
 *   - Modern era `stampResultType` reads the TOP-LEVEL `result["resultType"]`.
 *     `taskToResult` puts `resultType` inside `structuredContent`, so the top
 *     level is absent → stamped `"complete"`. `decodeResult` then sees
 *     `"complete"` and treats the result as an ordinary completion. The
 *     client never recognises a task handle and never polls `tasks/get`.
 *   - Legacy era `decodeResult` strips any top-level `resultType` and also
 *     returns `kind: "complete"`. Same outcome.
 *
 * So `clientHasTasksCap` returning true would hand the client a result it
 * cannot act on — terraform would run in the background with no pollable
 * handle. Until the SDK ships a real task runtime (poll-based `tasks/get` +
 * `tasks/update` per SEP-2663, with a result shape the codec recognises),
 * `launchTaskResult` uses the synchronous + progress-notifications fallback
 * (`runWithProgress` in terraform.ts) regardless of the client's declared
 * capability. The task scaffolding (manager.ts, handlers.ts, `launchTerraformTask`,
 * `taskToResult`) is kept for that future SDK.
 *
 * ## supportedProtocolVersions
 *
 * Passed the SDK's `SUPPORTED_PROTOCOL_VERSIONS` (the 2025-era list). This
 * advertises the legacy revisions we accept; it does not constrain which era
 * `serveStdio` pins (the classifier decides that from the opening message).
 * A modern-era client is served on 2026-07-28 regardless of this list.
 */
export function createServer(): McpServer {
  const mcp = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      capabilities: {
        tools: {},
        // Advertise the tasks extension. The task *result* path is broken
        // under SDK 2.0.0 (see the method comment), so long-running terraform
        // tools currently use the synchronous + progress-notifications
        // fallback regardless of this advertisement. Kept so a future SDK
        // with a real task runtime can light it up without touching capabilities.
        extensions: {
          "io.modelcontextprotocol/tasks": {},
        },
      },
      instructions: SERVER_INSTRUCTIONS,
      // Advertise the 2025-era revisions we accept. Does not gate the era —
      // see the method comment: serveStdio's classifier pins the era from the
      // opening message, not from this list.
      supportedProtocolVersions: [...SUPPORTED_PROTOCOL_VERSIONS],
    },
  );

  registerTaskHandlers(mcp.server);
  registerAllTools(mcp);

  // Approval mode is out of band: it is set by the client UI over
  // permission/set_mode, never by the model, and it is not persisted — a new
  // process starts at the default. Report the startup state on stderr (the
  // log channel; stdout carries JSON-RPC) so an operator can see what the
  // session opened with, and so a registry that failed to load is announced
  // here rather than discovered from a refused request.
  const registry = registryStatus();
  process.stderr.write(`permission: starting in ${getMode()} mode\n`);
  if (registry.error !== undefined) {
    process.stderr.write(
      `permission: registry unavailable — every non-GET/HEAD request will be ` +
        `refused in read-only mode: ${registry.error}\n`,
    );
  }
  registerPermissionMethods(mcp.server);
  registerCredentialMethods(mcp.server);

  // Credential scope, for the same diagnostic reason: it decides which keychain
  // entry and file this process reads and writes, so "why is it authenticated
  // as someone else" is answerable from the log alone. The scope name is
  // non-secret — no credential value is ever printed.
  process.stderr.write(`credentials: scope "${SCOPE}"\n`);

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
 * `_meta` envelope, decides the era — 2026-07-28 modern or 2025 legacy — and
 * pins one server instance for the connection lifetime). The bare transport
 * would only serve legacy; `serveStdio` is the canonical entry the SDK
 * documents for stdio serving and handles both eras, which we support.
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

/**
 * Default HTTP listen port. Overridable via `--port`.
 *
 * 9527 — not claimed by any common dev server (3000/5173/8080 all collide
 * with React/Vite/Express defaults), and memorable. Overridable via `--port`.
 */
const DEFAULT_HTTP_PORT = 9527;

/**
 * Default bind address. Loopback only — see `serveHttp` for why.
 */
const DEFAULT_HTTP_HOST = "127.0.0.1";

/**
 * Start the server over HTTP (Streamable HTTP transport) and run until killed.
 *
 * Unlike stdio (one client spawns one process), HTTP serves multiple requests
 * over one process. The same single-operator model still holds: credential
 * scope, permission mode, and the in-memory credential cache are process-wide,
 * so every request on this server shares one identity. Binding loopback keeps
 * that model sound — a non-loopback bind would let other machines reach this
 * process's stored credentials, which is not what `HW_DEFAULT_PERMISSION` /
 * credential scope were designed for. Pass `--host 0.0.0.0` to override, but
 * only behind a reverse proxy that handles auth and network isolation.
 *
 * `createMcpHandler` owns the same opening-exchange era classification that
 * `serveStdio` does: a request carrying the 2026-07-28 `_meta` envelope is
 * served modern, a legacy `initialize` is served on 2025. The factory
 * (`createServer`) is the same one stdio uses, so both eras get the same
 * tools. Modern traffic is served per-request (a fresh instance per
 * exchange); legacy traffic is served stateless (a fresh instance per
 * request). Neither holds session state on the server side beyond the
 * process-wide caches, which is consistent with how stdio already behaves.
 *
 * `toNodeHandler` adapts the handler's web-standard `.fetch(Request)` to
 * Node's `(req, res)` shape. The Host/Origin guards (`localhostHostValidation`
 * / `localhostOriginValidation`) reject DNS-rebinding and cross-origin
 * requests — the same protection the SDK's framework app factories apply,
 * composed here by hand because plain `node:http` has no middleware chain.
 */
export async function serveHttp(
  port: number = DEFAULT_HTTP_PORT,
  host: string = DEFAULT_HTTP_HOST,
): Promise<void> {
  const handler = createMcpHandler(() => createServer());
  const nodeHandler = toNodeHandler(handler, {
    onerror: (err) => process.stderr.write(`http: handler error: ${err.message}\n`),
  });
  const validateHost = localhostHostValidation();
  const validateOrigin = localhostOriginValidation();

  const server = createHttpServer(async (req, res) => {
    // The guards answer rejected requests with 403 themselves and return
    // false; the handler must not touch the request further.
    if (!validateHost(req, res) || !validateOrigin(req, res)) return;
    // `toNodeHandler`'s signature takes the SDK's duck-typed
    // NodeIncomingMessageLike/NodeServerResponseLike (optional fields without
    // `| undefined`, for consumers that pass lighter shapes). Under our
    // `exactOptionalPropertyTypes: true` the real IncomingMessage — whose
    // `method` is `string | undefined` — does not structurally match. The
    // adapter accepts the real Node types at runtime; the cast bridges the
    // strictness gap without weakening the rest of the codebase.
    await nodeHandler(req as unknown as Parameters<typeof nodeHandler>[0], res);
  });

  // The server emits 'error' on bind failure (EADDRINUSE etc.) — listen so it
  // surfaces as a Fatal: line via index.ts's .catch() rather than an uncaught
  // exception. The 'listening' event fires once bound successfully.
  const isLoopback = host === "127.0.0.1" || host === "localhost" || host === "::1";
  const bindLabel = isLoopback ? " (loopback)" : "";

  server.on("error", (err) => {
    const code = (err as NodeJS.ErrnoException).code;
    process.stderr.write(`http: ${code ?? "error"}: ${err.message}\n`);
    process.exit(1);
  });

  server.listen(port, host, () => {
    process.stderr.write(`http: listening on http://${host}:${port}${bindLabel}\n`);
  });

  // Keep the process alive until interrupted. Unlike stdio there is no stdin
  // lifecycle to tie to, so resolve never — the process exits on SIGINT/SIGTERM
  // or on a bind error above.
  await new Promise<void>(() => {});
}
