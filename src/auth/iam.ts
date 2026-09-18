/**
 * IAM credential verification (§5.3 persistAndVerify step).
 *
 * Called by auth's persistAndVerify BEFORE keychain persistence — the
 * credentials are not yet stored, so this signs with the caller-provided
 * AK/SK by passing them explicitly to signedHttp (which otherwise loads
 * from keychain). A failed verification means the credentials are rejected
 * and never persisted.
 *
 * Endpoint: GET https://iam.{region}.myhuaweicloud.com/v3/projects
 *   - Verified to accept SDK-HMAC-SHA256 signing (signer.ts end-to-end test).
 *   - Response: { projects: [{ id, name, domain_id, ... }] }
 *   - domain_id IS the account_id (华为云 "domain" == 账号; the IAM swagger
 *     KeystoneListProjects ProjectResult.domain_id description reads
 *     "项目所属账号ID"). One account may own many projects; we take
 *     domain_id from the first project (all projects of one AK/SK share
 *     the same domain_id).
 *
 * IAM is a GLOBAL service: the projects/domains returned are identical
 * regardless of which region endpoint is hit. The region in the URL only
 * routes to a regional IAM endpoint replica — it does NOT scope the result.
 * Consequence: this verification validates the AK/SK (and STS token), NOT
 * the region. A wrong region still 200s here with the same account identity;
 * a wrong region surfaces later, at the first region-scoped call (terraform
 * init's provider, or a region-scoped API). That decoupling is correct —
 * credential validity and region validity are independent concerns, and
 * conflating them would produce misleading "invalid credentials" errors
 * when the real problem is a typo'd region.
 *
 * Account name: /v3/projects does not return the domain name. We best-effort
 * query GET /v3/auth/domains for { id, name } — if it 200s we record the
 * domain name; if it fails (some AK/SK scopes may not grant it), we fall
 * back to the domain_id as the name. Account name is diagnostic-only
 * (identifies "which account owns this deployment" in .deployment.json),
 * so a missing name never blocks authentication.
 */

import { signedHttp } from "./http.js";
import type { Credentials } from "./store.js";

export interface VerifiedAccount {
  /** 华为云账号 ID (== IAM domain_id). */
  account_id: string;
  /** 账号名 (domain name); falls back to account_id if unavailable. */
  name: string;
  /** The region-scoped project id used for signing context. */
  project_id?: string | undefined;
}

export interface VerifyResult {
  ok: true;
  account: VerifiedAccount;
}

export interface VerifyFailure {
  ok: false;
  /** HTTP status from IAM (0 = network/Signing error, not an IAM response). */
  status: number;
  /** Human-readable reason surfaced to the LLM/user. */
  message: string;
}

/**
 * Verify credentials against IAM by listing projects.
 *
 * Returns a discriminated union so the caller can branch without try/catch
 * — auth failures (401/403) are expected, not exceptional. The explicit
 * `creds` arg flows straight into signedHttp, bypassing the keychain load
 * (these creds aren't stored yet).
 */
export async function verifyCredentials(creds: Credentials): Promise<VerifyResult | VerifyFailure> {
  const iamUrl = new URL(`https://iam.${creds.region}.myhuaweicloud.com/v3/projects`);

  let status: number;
  let body: string;
  try {
    const resp = await signedHttp("GET", iamUrl, "", {}, creds);
    status = resp.status;
    body = resp.body;
  } catch (err) {
    return { ok: false, status: 0, message: `IAM 请求失败: ${err instanceof Error ? err.message : String(err)}` };
  }

  if (status !== 200) {
    return { ok: false, status, message: parseIamError(status, body) };
  }

  // Parse projects — take domain_id from the first project (all projects of
  // one AK/SK share the same domain_id).
  let projects: Array<{ id?: string | undefined; name?: string | undefined; domain_id?: string | undefined }>;
  try {
    const parsed = JSON.parse(body) as { projects?: Array<Record<string, unknown>> };
    projects = (parsed.projects ?? []).map((p) => ({
      id: typeof p["id"] === "string" ? p["id"] : undefined,
      name: typeof p["name"] === "string" ? p["name"] : undefined,
      domain_id: typeof p["domain_id"] === "string" ? p["domain_id"] : undefined,
    }));
  } catch (err) {
    return { ok: false, status, message: `IAM 响应解析失败: ${err instanceof Error ? err.message : String(err)}` };
  }

  if (projects.length === 0) {
    // Credentials authenticated (200) but the AK/SK sees no projects.
    // IAM is a global service (see module doc) — projects returned do NOT
    // depend on the region in the URL, so an empty list is NOT a region
    // problem. It means the IAM user has no project visibility: either the
    // AK/SK lacks IAM read scope, or a sub-account whose parent hasn't
    // granted project membership. terraform needs a project, so reject.
    return {
      ok: false,
      status,
      message: "凭证有效但无可见项目 — 请确认 AK/SK 有 IAM 只读权限，或联系主账号授予项目权限（与 region 无关，IAM 为全局服务）",
    };
  }

  const first = projects[0]!;
  const accountId = first.domain_id;
  if (!accountId) {
    return { ok: false, status, message: "IAM 响应缺少 domain_id — 无法确定账号" };
  }

  // Best-effort account name via /v3/auth/domains. Non-blocking on failure.
  const name = await fetchDomainName(creds, accountId).catch(() => null) ?? accountId;
  const projectId = first.id;
  return { ok: true, account: { account_id: accountId, name, project_id: projectId } };
}

/**
 * Best-effort: fetch the domain (account) name via GET /v3/auth/domains.
 *
 * Returns null on any failure — account name is diagnostic-only. Some AK/SK
 * scopes may not grant this endpoint; we never block auth on it. The signed
 * request shares the sign+fetch path with all other callers (signedHttp).
 */
async function fetchDomainName(creds: Credentials, expectedDomainId: string): Promise<string | null> {
  const url = new URL(`https://iam.${creds.region}.myhuaweicloud.com/v3/auth/domains`);
  let resp;
  try {
    resp = await signedHttp("GET", url, "", {}, creds);
  } catch {
    return null;
  }
  if (resp.status !== 200) return null;
  let parsed: { domains?: Array<{ id?: string; name?: string }> } | null;
  try {
    parsed = JSON.parse(resp.body) as { domains?: Array<{ id?: string; name?: string }> };
  } catch {
    return null;
  }
  const match = parsed?.domains?.find((d) => d.id === expectedDomainId);
  return match?.name ?? null;
}

/** Render an IAM non-200 response into a user-readable reason. */
function parseIamError(status: number, body: string): string {
  // IAM error body: { error_msg: "...", error_code: "IAM.xxxx" }
  try {
    const parsed = JSON.parse(body) as { error_msg?: string; error_code?: string; message?: string };
    const msg = parsed.error_msg ?? parsed.message;
    if (msg) return `凭证无效 (HTTP ${status}${parsed.error_code ? `, ${parsed.error_code}` : ""}): ${msg}`;
  } catch { /* non-JSON error body */ }
  if (status === 401) return `凭证无效 (HTTP 401): AK/SK 或 STS token 被拒绝`;
  if (status === 403) return `凭证有效但权限不足 (HTTP 403): 无法列出项目 — 请确认 AK/SK 有 IAM 只读权限`;
  return `IAM 验证失败 (HTTP ${status}): ${body.slice(0, 200)}`;
}
