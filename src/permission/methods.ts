/**
 * The out-of-band mode switch, as MCP requests.
 *
 * Two custom methods on the low-level Server:
 *
 *   permission/get_mode  -> { mode, default, writable }
 *   permission/set_mode  <- { mode }
 *
 * ## Why a custom method and not a tool
 *
 * A tool would be listed by `tools/list`, described to the model, and callable
 * by it — which is exactly what this must not be. An MCP request method that
 * is not a tool is invisible to the model: it appears in no tool list, no
 * description, and no prompt. The model cannot read the mode and cannot set
 * it. Only a client that knows the method name can use it.
 *
 * ## Why these names are safe on the wire
 *
 * The SDK era-gates methods by registry membership: a method in a protocol
 * revision's registry is refused with `-32601` on a connection that negotiated
 * an era lacking it, while "a method outside it is a consumer-owned extension
 * method (era-blind, schema-explicit)". Both names here are outside every
 * registry, so they work on the 2025 and 2026-07-28 eras alike. This is the
 * opposite of `tasks/get`, which belongs to the 2025 registry and is therefore
 * unreachable on a 2026 connection.
 *
 * Registry membership is only the first gate. The modern era additionally
 * requires the per-request `_meta` envelope
 * (`io.modelcontextprotocol/protocolVersion` and
 * `io.modelcontextprotocol/clientCapabilities`) on *every* request, custom
 * methods included — the codec enforces it at dispatch, after the registry
 * check and before the handler runs, answering `-32602` when it is missing.
 * The SDK's own client stamps the envelope, so this holds without any effort
 * from us; but a hand-rolled client that speaks these methods directly must
 * send it, or the failure will look like a malformed parameter rather than a
 * missing envelope.
 *
 * The consequence to keep in mind when editing: choosing a name that *is* a
 * spec method (anything under `tools/`, `resources/`, `tasks/`, `prompts/`,
 * `sampling/`, `elicitation/`, or an existing spec name) would silently
 * acquire era gating. `permission/*` is not a spec namespace — keep it that
 * way.
 *
 * Verified on a 2026-07-28 connection: the request reaches the handler, the
 * method does not appear in `tools/list`, an unknown sibling answers `-32601`,
 * and a bad argument answers `-32602`.
 *
 * @module permission/methods
 */

import type { Server } from "@modelcontextprotocol/server";
import { z } from "zod";

import { defaultMode, getMode, setMode, type PermissionMode } from "./mode.js";

/** Wire spelling of the mode — snake_case, matching the registry's vocabulary. */
const ModeSchema = z.enum(["read_only", "read_write"]);

/** Params for `permission/set_mode`. */
const SetModeParamsSchema = z.object({
  mode: ModeSchema.describe("read_only refuses cloud mutations; read_write permits them."),
});

/** Result for `permission/set_mode`. */
const SetModeResultSchema = z.object({
  mode: ModeSchema.describe("The mode now in effect."),
  previous: ModeSchema.describe("The mode before this call."),
  changed: z.boolean().describe("Whether the mode actually changed."),
});

/** Params for `permission/get_mode` — empty; clients may omit params entirely. */
const GetModeParamsSchema = z.object({}).loose();

/** Result for `permission/get_mode`. */
const GetModeResultSchema = z.object({
  mode: ModeSchema.describe("The mode now in effect."),
  default: ModeSchema.describe("The mode this process started in."),
  writable: z.boolean().describe("Whether mutations are currently permitted."),
});

/**
 * Register the two mode methods on the low-level Server.
 *
 * Must be called before the transport is connected: `registerCapabilities`
 * refuses once a transport is attached.
 *
 * @param server - the low-level server behind `McpServer`.
 */
export function registerPermissionMethods(server: Server): void {
  server.setRequestHandler(
    "permission/set_mode",
    { params: SetModeParamsSchema, result: SetModeResultSchema },
    async (params) => {
      const previous = setMode(params.mode);
      const changed = previous !== params.mode;
      // stderr, never stdout (the protocol channel) and never a tool result —
      // the model must not learn the mode from either.
      process.stderr.write(
        `permission: mode ${changed ? `${previous} -> ${params.mode}` : `unchanged (${params.mode})`}\n`,
      );
      return { mode: params.mode, previous, changed };
    },
  );

  server.setRequestHandler(
    "permission/get_mode",
    { params: GetModeParamsSchema, result: GetModeResultSchema },
    async (): Promise<{ mode: PermissionMode; default: PermissionMode; writable: boolean }> => {
      const mode = getMode();
      return { mode, default: defaultMode(), writable: mode === "read_write" };
    },
  );
}