/**
 * SDK-HMAC-SHA256 request signing for HuaweiCloud APIs.
 *
 * DESIGN.zh.md §5.5: openapi_request signs requests internally with AK/SK;
 * the client never handles credentials. This implements the HuaweiCloud
 * SDK-HMAC-SHA256 algorithm:
 *
 *   1. Build the canonical request (method, URI, query, headers, signed
 *      header list, hashed body).
 *   2. Build the string-to-sign: "SDK-HMAC-SHA256\n<timestamp>\n<hash>".
 *   3. The signing key is the SK itself (HuaweiCloud's scheme is simpler
 *      than AWS sigv4 — no date/region-derived key chain); the signature
 *      is HMAC-SHA256(sk, string-to-sign), hex-encoded.
 *
 * Status: verified end-to-end against real HuaweiCloud APIs:
 *   - IAM GET /v3/projects → 200
 *   - BSS GET /v2/accounts/customer-accounts/balances → 200
 *   - BSS GET /v2/promotions/benefits/coupons → 200
 * The signer is production-ready. The shared signed HTTP client in
 * auth/http.ts wraps this + fetch for all callers.
 */

import { createHash, createHmac } from "node:crypto";

export interface SigningParams {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body: string;
  ak: string;
  sk: string;
  region: string;
  /** STS token if using temporary credentials. */
  securityToken?: string | undefined;
}

export interface SignedRequest {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body: string;
}

/**
 * Sign a HuaweiCloud API request. Mutates headers in place to add
 * Authorization, X-Sdk-Date, and (if STS) X-Security-Token.
 *
 * @see https://support.huaweicloud.com/api-iam/iam_30_0001.html
 */
export function signRequest(params: SigningParams): SignedRequest {
  const { method, url, headers, body, ak, sk } = params;
  // X-Sdk-Date format: YYYYMMDDTHHMMSSZ (e.g. 20060529T131456Z) — keep the T.
  const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const sdkDate = timestamp.replace(/[-:]/g, "");

  // X-Sdk-Date must be in headers BEFORE computing signed headers.
  headers["X-Sdk-Date"] = sdkDate;

  // 1. Hash the body.
  const bodyHash = sha256Hex(body);

  // 2. Canonical headers: lowercase keys, sorted, trimmed values.
  const headerEntries: Array<[string, string]> = Object.entries(headers)
    .map(([k, v]) => [k.toLowerCase().trim(), v.trim()] as [string, string])
    .sort(([a], [b]) => a.localeCompare(b));
  const canonicalHeaders = headerEntries.map(([k, v]) => `${k}:${v}\n`).join("");
  const signedHeaders = headerEntries.map(([k]) => k).join(";");

  // 3. Canonical URI: trim slashes, URL-encode each segment, rejoin with
  //    trailing slash.
  const trimmed = url.pathname.replace(/^\/+|\/+$/g, "");
  const canonicalUri = trimmed === ""
    ? "/"
    : "/" + trimmed.split("/").map(encodeRfc3986).join("/") + "/";
  const canonicalQueryString = canonicalQuery(url.searchParams);

  // 4. Canonical request.
  const canonicalRequest = [
    method.toUpperCase(),
    canonicalUri,
    canonicalQueryString,
    canonicalHeaders,
    signedHeaders,
    bodyHash,
  ].join("\n");

  // 5. String to sign.
  const stringToSign = ["SDK-HMAC-SHA256", sdkDate, sha256Hex(canonicalRequest)].join("\n");

  // 6. Signature: HMAC-SHA256(sk, stringToSign), hex.
  const signature = createHmac("sha256", sk).update(stringToSign).digest("hex");

  // 7. Authorization header.
  const auth = [
    `SDK-HMAC-SHA256 Access=${ak}`,
    `SignedHeaders=${signedHeaders}`,
    `Signature=${signature}`,
  ].join(", ");

  headers["Authorization"] = auth;
  if (params.securityToken) {
    headers["X-Security-Token"] = params.securityToken;
  }

  return { method, url, headers, body };
}

/** SHA-256 hex digest of a string. */
function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

/** Canonical query string: keys sorted, RFC 3986 encoded, key=value joined by &. */
function canonicalQuery(params: URLSearchParams): string {
  const pairs: Array<[string, string]> = [];
  for (const [k, v] of params.entries()) {
    pairs.push([encodeRfc3986(k), encodeRfc3986(v)]);
  }
  pairs.sort(([a], [b]) => a.localeCompare(b));
  return pairs.map(([k, v]) => `${k}=${v}`).join("&");
}

function encodeRfc3986(s: string): string {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}
