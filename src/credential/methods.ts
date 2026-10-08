/**
 * The credential reset method, as an MCP request.
 *
 *   credential/reset  -> { scope, keychain, file, env_active }
 *
 * ## Why a custom method and not a tool
 *
 * Reset clears stored credentials — it is an operator action, not a step in
 * any deployment flow. A tool would be listed by `tools/list`, described to
 * the model, and callable by it, which is exactly what this must not be: the
 * model has no business clearing credentials mid-session, and a reset must
 * not look like a normal tool call the model might retry. An MCP request
 * method that is not a tool is invisible to the model, exactly like
 * `permission/set_mode`.
 *
 * ## What it clears, and what it cannot
 *
 * Session memory, the scoped keychain entry, and the scoped fallback file.
 * Env vars (`HW_ACCESS_KEY` etc.) are set by the MCP client in its spawn
 * config and cannot be reached from here; when they are present the result
 * says so (`env_active: true`), so a reset never looks like a silent no-op
 * on a client that carries its own credentials.
 *
 * The result carries no credential value — only scope name and booleans.
 *
 * ## Era safety
 *
 * `credential/*` is not a spec namespace (nothing under it appears in any
 * protocol revision's method registry), so the name is era-blind and works
 * on 2025 and 2026-07-28 alike. The modern era still requires the per-request
 * `_meta` envelope on every request, custom methods included; the SDK's own
 * client stamps it, and a hand-rolled client must too.
 *
 * Verified on a 2026-07-28 connection: the request reaches the handler, the
 * method does not appear in `tools/list`, an unknown sibling answers `-32601`,
 * and a bad argument answers `-32602`.
 *
 * @module credential/methods
 */

import type { Server } from "@modelcontextprotocol/server";
import { z } from "zod";

import { clearCredentials } from "../auth/store.js";

/** Params for `credential/reset` — empty; clients may omit params entirely. */
const ResetParamsSchema = z.object({}).loose();

/** Result for `credential/reset`. */
const ResetResultSchema = z.object({
  scope: z.string().describe("The scope whose stored credentials were removed."),
  keychain: z.boolean().describe("True if the keychain was reached and the delete ran."),
  file: z.boolean().describe("True if the fallback file was deleted, or was already absent."),
  env_active: z.boolean().describe(
    "True if HW_ACCESS_KEY/HW_SECRET_KEY/HW_REGION_NAME env vars are set — the client still authenticates from env after reset.",
  ),
});

/**
 * Register the reset method on the low-level Server.
 *
 * Must be called before the transport is connected.
 *
 * @param server - the low-level server behind `McpServer`.
 */
export function registerCredentialMethods(server: Server): void {
  server.setRequestHandler(
    "credential/reset",
    { params: ResetParamsSchema, result: ResetResultSchema },
    async () => {
      const result = await clearCredentials();
      // stderr diagnostic for the operator — the log channel, not the protocol
      // channel. Only the scope name (non-secret) and booleans appear; no
      // credential value is ever written.
      process.stderr.write(
        `credential: reset scope "${result.scope}" (keychain=${result.keychain}, file=${result.file}, env_active=${result.env_active})\n`,
      );
      return result;
    },
  );
}
