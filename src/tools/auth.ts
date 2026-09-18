import {
  type CallToolResult,
  inputRequired,
  inputResponse,
  type McpServer,
  type Server,
} from "@modelcontextprotocol/server";
import { z } from "zod";

import { type ToolCtx, type ToolResult, fail, guard, ok } from "./errors.js";
import { saveCredentials, type Credentials } from "../auth/store.js";
import { verifyCredentials } from "../auth/iam.js";

/**
 * auth() — Authenticate with HuaweiCloud (§5.3).
 *
 * Takes NO parameters. AK/SK/region are collected via MCP elicitation so
 * credentials never enter the LLM tool-call context. The handler runs
 * twice:
 *
 *   1. First leg (inputResponses empty): read env vars for prefill, return
 *      inputRequired with an elicitation form. The client shows the form to
 *      the user (NOT the LLM), user fills AK/SK, client retries tools/call
 *      with inputResponses.
 *   2. Second leg (inputResponses present): read the user's input via
 *      acceptedContent, validate against HuaweiCloud IAM (GET /v3/projects),
 *      persist to keychain. Return { authenticated, region, account } to
 *      the LLM.
 *
 * Era handling (§5.3): legacyShim is default-on, so on 2025-era stdio
 * clients the inputRequired return is auto-converted to the old
 * elicitation/create server→client request + handler re-entry. Do NOT set
 * `inputRequired.legacyShim: false`.
 *
 * Capability detection (§5.3): the server probes
 * server.getClientCapabilities()?.elicitation to decide whether to use the
 * elicitation path or the env-var degradation. The Server reference is
 * captured at registration time (registerAuthTool receives the McpServer),
 * not passed through ctx — ctx doesn't expose the server.
 *
 * Degradation (§5.3): if the client did not declare elicitation capability,
 * we fall back to reading HW_ACCESS_KEY etc. directly — never to AK/SK tool
 * args (that would leak into LLM context).
 *
 * Verification: both legs call persistAndVerify, which signs a GET
 * /v3/projects request with the supplied AK/SK and confirms a 200 before
 * persisting. Invalid credentials are rejected with the IAM error — they
 * never reach keychain.
 */
export function registerAuthTool(mcp: McpServer): void {
  // Capture the low-level Server for capability probing. The handler closure
  // holds this reference; ctx (ServerContext) does not expose the server.
  const server = mcp.server;

  mcp.registerTool(
    "auth",
    {
      title: "HuaweiCloud 认证",
      description:
        "Authenticate with HuaweiCloud. Takes NO parameters — AK/SK/region are " +
        "collected via MCP elicitation (a form pops up for the user), so " +
        "credentials never enter the tool-call context. Verifies via GET " +
        "/v3/projects (signed). Persists to OS keychain (or " +
        "machine-fingerprint-bound file fallback). STS (security_token) not " +
        "persisted. Subsequent tools read credentials automatically. If " +
        "elicitation is unsupported, falls back to HW_ACCESS_KEY/HW_SECRET_KEY/" +
        "HW_REGION_NAME env vars.",
      inputSchema: z.object({}),
    },
    guard(async (_args, ctx) => handleAuth(ctx, server)),
  );
}

/** The elicitation form schema — the *content* shape the user fills. */
const credentialFormSchema = z.object({
  ak: z.string().describe("华为云 Access Key（AK）"),
  sk: z.string().describe("华为云 Secret Key（SK）"),
  region: z.string().describe("区域，如 cn-north-4"),
  security_token: z.string().optional().describe("STS 临时令牌（永久 AK/SK 留空）"),
});

export async function handleAuth(ctx: ToolCtx, server: Server): Promise<ToolResult> {
  // Second leg: the client retried with inputResponses after the user acted
  // on the elicitation form. Distinguish accept / decline / cancel / missing
  // — only "accept" with valid content proceeds to verification. "decline" and
  // "cancel" must return a terminal result, NOT re-emit inputRequired (that
  // would loop the form forever until the user commits).
  const view = inputResponse(ctx.mcpReq.inputResponses, "credentials");
  if (view.kind === "elicit" && view.action === "accept" && view.content) {
    const parsed = credentialFormSchema.safeParse(view.content);
    if (parsed.success) {
      return persistAndVerify({
        ak: parsed.data.ak,
        sk: parsed.data.sk,
        region: parsed.data.region,
        security_token: parsed.data.security_token,
      });
    }
    // Content present but failed schema validation — re-elicit with a hint
    // so the user can correct, rather than silently looping.
    return elicitForm(readEnvPrefill(), "凭证格式有误，请重新填写");
  }
  if (view.kind === "elicit" && (view.action === "decline" || view.action === "cancel")) {
    return fail("用户取消认证。如需重试，请再次调用 auth。");
  }

  // First leg: no inputResponses yet (view.kind === "missing"). Check env
  // for prefill (§5.3 env prefill — env values go into form defaults, not
  // LLM context). Prefill is per-field: a set env var fills its field even
  // if others are missing, so a user who exported only AK/SK still sees them
  // pre-filled and just fills region in the form.
  const prefill = readEnvPrefill();
  const elicitSupport = clientSupportsElicitation(server);

  if (elicitSupport === "uninit") {
    // Engineering constraint (not a runtime assumption):
    // server.getClientCapabilities() returns undefined only when initialize
    // has not completed. Per MCP protocol, the client MUST complete
    // initialize before sending tools/call. Reaching here means the protocol
    // was violated — refuse with a clear error rather than guessing.
    return fail("server not initialized — client must complete initialize before calling tools");
  }

  if (elicitSupport === "no") {
    // Degradation path (§5.3): client has no elicitation capability.
    // AK/SK must come from env (cannot be guessed); region defaults to
    // cn-north-4 if unset. If AK or SK is missing, we cannot proceed.
    const ak = process.env["HW_ACCESS_KEY"];
    const sk = process.env["HW_SECRET_KEY"];
    if (!ak || !sk) {
      const missing = [!ak && "HW_ACCESS_KEY", !sk && "HW_SECRET_KEY"].filter(Boolean).join(", ");
      return fail(
        `客户端不支持 elicitation 表单，无法收集凭证。环境变量缺失：${missing}。请补齐后重试。`,
      );
    }
    const region = process.env["HW_REGION_NAME"] ?? "cn-north-4";
    const security_token = process.env["HW_SECURITY_TOKEN"];
    return persistAndVerify(
      security_token ? { ak, sk, region, security_token } : { ak, sk, region },
      "env",
    );
  }

  return elicitForm(prefill);
}

/**
 * Build the inputRequired return for the credential elicitation form.
 *
 * Env prefill is done via .default() on the zod fields (§5.3: env values go
 * into form defaults, not LLM context). The caller passes an optional message
 * override (e.g. for the schema-validation-retry case).
 */
function elicitForm(prefill: EnvPrefill, messageOverride?: string): ToolResult {
  const hasEnv = Boolean(prefill.ak || prefill.sk || prefill.region || prefill.security_token);
  const formSchema = z.object({
    ak: z.string().describe("华为云 Access Key").default(prefill.ak ?? ""),
    sk: z.string().describe("华为云 Secret Key").default(prefill.sk ?? ""),
    region: z.string().describe("区域，如 cn-north-4").default(prefill.region ?? "cn-north-4"),
    security_token: z.string().optional().describe("STS 临时令牌（可选，配合临时ak、sk使用）").default(prefill.security_token ?? ""),
  });
  const CREDENTIAL_URL =
    "https://console.huaweicloud.com/apiexplorer/#/openapi/IAM/doc?version=v3&api=CreateTemporaryAccessKeyByToken";
  // message is a single-line string (spec: z.string(); clients render it as
  // one line). Compose a readable sentence with the credential-source hint;
  // append the env-prefill note when relevant.
  const base = `需要进行华为云 IAM 认证，建议从 ${CREDENTIAL_URL} 获取临时凭据，避免使用永久凭据`;
  const message = messageOverride ?? (hasEnv ? `${base}（检测到环境变量，已预填）` : base);
  return inputRequired({
    inputRequests: {
      credentials: inputRequired.elicit({
        message,
        requestedSchema: formSchema,
      }),
    },
  });
}

/**
 * Check whether the client declared elicitation capability.
 *
 * §5.3 capability detection: server.getClientCapabilities() returns the
 * client's initialize-declared capabilities. On 2025-era connections this
 * is the initialize-scoped value; on 2026-era the per-request envelope
 * backfills it (the SDK's getClientCapabilities doc confirms this).
 *
 * The legacyShim consults these and rejects inputRequired per-family when
 * elicitation is absent. By probing here BEFORE returning inputRequired,
 * we route to the env-var degradation directly — avoiding a shim rejection
 * that would leave the handler unre-entered (the dead-code bug from P1).
 *
 * Returns:
 *   "yes"    — elicitation capability declared, use the elicitation path
 *   "no"     — capability absent, degrade to env vars
 *   "uninit" — server.getClientCapabilities() returned undefined, meaning
 *              initialize has not completed. Per MCP protocol, the client
 *              MUST complete initialize before sending tools/call — if we
 *              reach here, the protocol was violated. We refuse rather than
 *              guess, because guessing "supported" leads to a shim rejection
 *              the user can't recover from, and guessing "unsupported"
 *              forces an unneeded env-var degradation. The error tells the
 *              client to complete initialize first.
 */
function clientSupportsElicitation(server: Server): "yes" | "no" | "uninit" {
  const caps = server.getClientCapabilities();
  if (!caps) return "uninit";
  return caps.elicitation ? "yes" : "no";
}

/**
 * Per-field env prefill for the elicitation form. Unlike
 * {@linkcode readEnvCredentials}, this does NOT require all three vars to be
 * set — each field is filled from its own env var independently, so a user
 * who exported only AK/SK still sees them pre-filled and just fills region
 * in the form. A field whose env var is unset comes back as `undefined`,
 * which `elicitForm` maps to the field's own fallback (empty string, or
 * "cn-north-4" for region).
 */
interface EnvPrefill {
  ak?: string;
  sk?: string;
  region?: string;
  security_token?: string;
}

function readEnvPrefill(): EnvPrefill {
  const prefill: EnvPrefill = {};
  const ak = process.env["HW_ACCESS_KEY"];
  const sk = process.env["HW_SECRET_KEY"];
  const region = process.env["HW_REGION_NAME"];
  const security_token = process.env["HW_SECURITY_TOKEN"];
  if (ak) prefill.ak = ak;
  if (sk) prefill.sk = sk;
  if (region) prefill.region = region;
  if (security_token) prefill.security_token = security_token;
  return prefill;
}

/**
 * Read HW_ACCESS_KEY / HW_SECRET_KEY / HW_REGION_NAME / HW_SECURITY_TOKEN from env.
 * Names match the provider's documented env vars (docs/index.md).
 *
 * Returns null unless all three required vars (AK/SK/region) are set — use
 * this only when you need a complete credential set (e.g. the no-elicitation
 * degradation path that must verify directly). For form prefill use
 * {@linkcode readEnvPrefill} instead.
 *
 * Exported for testing — pure function, no side effects (reads process.env).
 */
export function readEnvCredentials(): Credentials | null {
  const ak = process.env["HW_ACCESS_KEY"];
  const sk = process.env["HW_SECRET_KEY"];
  const region = process.env["HW_REGION_NAME"];
  if (!ak || !sk || !region) return null;
  const security_token = process.env["HW_SECURITY_TOKEN"];
  return security_token ? { ak, sk, region, security_token } : { ak, sk, region };
}

/**
 * Verify credentials against IAM, then persist on success.
 *
 * §5.3 flow: sign GET /v3/projects with the supplied AK/SK → 200 means valid.
 * Only on success do we saveCredentials (with the resolved account identity).
 * On failure we return the IAM error and persist nothing — the user must
 * retry auth with correct credentials.
 *
 * STS (security_token) credentials are verified the same way (the signer
 * adds X-Security-Token); they pass through to the in-memory session on
 * success, never persisted.
 */
async function persistAndVerify(creds: Credentials, source: "env" | "form" = "form"): Promise<CallToolResult> {
  const result = await verifyCredentials(creds);
  if (!result.ok) {
    return fail(result.message);
  }
  try {
    await saveCredentials(creds, {
      account_id: result.account.account_id,
      account_name: result.account.name,
    });
    return ok(
      JSON.stringify({
        authenticated: true,
        region: creds.region,
        account: {
          account_id: result.account.account_id,
          name: result.account.name,
        },
        project_id: result.account.project_id,
        credential_source: creds.security_token ? "session" : source,
        sts: Boolean(creds.security_token),
      }),
    );
  } catch (err) {
    return fail(`凭证验证通过但存储失败: ${err instanceof Error ? err.message : String(err)}`);
  }
}
