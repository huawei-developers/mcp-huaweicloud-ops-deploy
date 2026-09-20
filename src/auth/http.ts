/**
 * Signed HTTP client — single source of truth for sign + fetch.
 *
 * All signed requests to HuaweiCloud APIs go through here: openapi_request,
 * balance_summary, and IAM credential verification (auth/iam.ts). Keeping
 * the sign+fetch in one place means signing headers, retries, and error
 * handling are maintained once.
 *
 * Credentials come from one of two places:
 *   - Default (no `creds` arg): loaded from keychain/session via
 *     loadCredentials. Used by tools that run after auth has persisted creds.
 *   - Explicit `creds` arg: used by auth/iam.ts verifyCredentials, which
 *     signs with not-yet-persisted credentials (it must verify BEFORE
 *     storing — storing invalid creds would lock the user out).
 *
 * Verified end-to-end against HuaweiCloud APIs:
 *   - IAM GET /v3/projects → 200
 *   - BSS GET /v2/accounts/customer-accounts/balances → 200
 *   - BSS GET /v2/promotions/benefits/coupons → 200
 */

import { signRequest } from "./signer.js";
import { signObsRequest } from "./obs_signer.js";
import { loadCredentials, type Credentials } from "./store.js";

/**
 * Whether a host targets OBS (Object Storage Service).
 *
 * OBS endpoints take two forms:
 *   - Global:  obs.<region>.myhuaweicloud.com
 *   - Bucket:  <bucket>.obs.<region>.myhuaweicloud.com  (virtual-hosted style)
 *
 * The rule `startsWith("obs.") || includes(".obs.")` matches both and does not
 * match other services (ecs/rds/bss/iam never contain ".obs.").
 */
function isObsHost(host: string): boolean {
  return host.startsWith("obs.") || host.includes(".obs.");
}

export interface SignedHttpResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

/**
 * Send a signed HTTP request to a HuaweiCloud API endpoint.
 *
 * The request is signed with SDK-HMAC-SHA256 (signer.ts). Host header is set
 * automatically; caller-provided headers are merged on top.
 *
 * @param creds optional explicit credentials. Omit to load from keychain
 *        (the normal post-auth path). Pass explicitly only when verifying
 *        credentials before they're persisted (auth/iam.ts).
 * @throws if not authenticated (call auth first) — only when `creds` is
 *         omitted and no credentials are stored.
 */
export async function signedHttp(
  method: string,
  url: URL,
  body: string,
  extraHeaders: Record<string, string> = {},
  creds?: Credentials,
): Promise<SignedHttpResponse> {
  const resolved = creds ?? await loadCredentials();
  // OBS uses a separate signature scheme (V2/OBS: HMAC-SHA1+base64). Dispatch
  // by host so openapi_request transparently works on OBS endpoints without
  // callers knowing which signer to use.
  const isObs = isObsHost(url.host);
  const headers: Record<string, string> = {
    Host: url.host,
    // OBS requests may carry non-JSON bodies (XML, octet-stream); default to
    // application/json only for IAM-style requests. OBS callers can override
    // via extraHeaders.
    ...(isObs ? {} : { "Content-Type": "application/json" }),
    ...extraHeaders,
  };
  if (isObs) {
    signObsRequest({
      method,
      url,
      headers,
      body,
      ak: resolved.ak,
      sk: resolved.sk,
      securityToken: resolved.security_token,
    });
  } else {
    signRequest({
      method,
      url,
      headers,
      body,
      ak: resolved.ak,
      sk: resolved.sk,
      region: resolved.region,
      securityToken: resolved.security_token,
    });
  }

  const init: RequestInit = { method, headers };
  if (body) init.body = body;
  // 30s timeout — API calls should not hang. AbortSignal.timeout is available
  // in Node 20+ (our engines requirement).
  init.signal = AbortSignal.timeout(30000);
  const r = await fetch(url, init);
  const respHeaders: Record<string, string> = {};
  r.headers.forEach((v, k) => { respHeaders[k] = v; });
  return {
    status: r.status,
    headers: respHeaders,
    body: await r.text(),
  };
}
