/**
 * OBS (Object Storage Service) V2/OBS request signing.
 *
 * OBS uses a signature scheme completely separate from IAM's SDK-HMAC-SHA256:
 *   - Algorithm: HMAC-SHA1, base64-encoded (not HMAC-SHA256 hex)
 *   - Authorization header: `OBS <AK>:<Signature>` (not `SDK-HMAC-SHA256 Access=...`)
 *   - StringToSign: six segments — HTTP-Verb, Content-MD5, Content-Type, Date,
 *     CanonicalizedHeaders, CanonicalizedResource — joined by "\n"
 *   - Date header: RFC 1123 GMT (not X-Sdk-Date)
 *
 * Ported from esdk-obs-nodejs 3.26.8 `doAuth` (utils.js line 1497-1578). The
 * SDK is CommonJS + log4js + callback-style + signature-negotiation; importing
 * it would pollute the ESM architecture, so the algorithm is ported instead.
 * The signing logic is HuaweiCloud's public spec — no copyright concern.
 *
 * Verified against the SDK source at /home/eushing/Downloads/utils.js.
 */

import { createHmac } from "node:crypto";

/**
 * Sub-resources that participate in CanonicalizedResource.
 *
 * Only query params in this whitelist enter the signature; all others are
 * ignored by the OBS server's canonical-resource construction. This is NOT
 * optional — including a non-whitelisted param would mismatch the server's
 * own StringToSign and produce 403 SignatureDoesNotMatch.
 *
 * Copied verbatim from esdk-obs-nodejs utils.js line 145-224.
 */
const ALLOWED_RESOURCE_PARAMETER_NAMES: ReadonlySet<string> = new Set([
  "acl",
  "backtosource",
  "policy",
  "torrent",
  "logging",
  "location",
  "storageinfo",
  "quota",
  "storageclass",
  "storagepolicy",
  "requestpayment",
  "versions",
  "versioning",
  "versionid",
  "uploads",
  "uploadid",
  "partnumber",
  "website",
  "notification",
  "replication",
  "lifecycle",
  "deletebucket",
  "delete",
  "cors",
  "restore",
  "tagging",
  "append",
  "position",
  "response-content-type",
  "response-content-language",
  "response-expires",
  "response-cache-control",
  "response-content-disposition",
  "response-content-encoding",
  "x-image-process",
  "x-oss-process",
  "x-image-save-object",
  "x-image-save-bucket",
  "encryption",
  "directcoldaccess",
  "rename",
  "name",
  "requestpayment",
  "metadata",
  "modify",
  "attname",
  "truncate",
  "x-obs-security-token",
  // workflow api
  "x-workflow-prefix",
  "x-workflow-start",
  "x-workflow-limit",
  "x-workflow-template-name",
  "x-workflow-graph-name",
  "x-workflow-execution-state",
  "x-workflow-execution-type",
  "x-workflow-next-marker",
  "obsworkflowtriggerpolicy",
  // virtual bucket api
  "obsbucketalias",
  "obsalias",
  "publicaccessblock",
  "bucketstatus",
  "policystatus",
  "customdomain",
  // inventory / worm / mirrorback / decompress sub-resources
  "inventory",
  "object-lock",
  "retention",
  "mirrorbacktosource",
  "obscompresspolicy",
  // truncate / modify sub-resources
  "length",
  "position",
]);

/** Header prefix for OBS custom headers (x-obs-). */
const HEADER_PREFIX = "x-obs-";
/** Header prefix for OBS user-metadata headers (x-obs-meta-). Values are trimmed. */
const HEADER_META_PREFIX = "x-obs-meta-";

export interface ObsSigningParams {
  method: string;
  url: URL;
  /** Caller-populated headers. Mutated in place: Authorization, Date, and
   *  x-obs-security-token (if STS) are added. Content-Type/Content-MD5, if
   *  present, participate in the signature. */
  headers: Record<string, string>;
  /** Request body. GET/HEAD/DELETE pass "". For PUT, the body content. The
   *  body itself is NOT directly in the StringToSign — Content-MD5 (if set)
   *  is the body's signature entry. */
  body: string;
  ak: string;
  sk: string;
  /** STS token if using temporary credentials. */
  securityToken?: string | undefined;
}

/**
 * Sign a HuaweiCloud OBS API request. Mutates `params.headers` to add:
 *   - `Date` (RFC 1123 GMT) — if not already set by the caller
 *   - `x-obs-security-token` — if `securityToken` is provided
 *   - `Authorization` — `OBS <AK>:<base64 signature>`
 *
 * The caller must set Content-Type and Content-MD5 (when applicable) BEFORE
 * calling this — they participate in the signature.
 *
 * @see https://support.huaweicloud.com/api-obs/obs_04_0010.html
 */
export function signObsRequest(params: ObsSigningParams): void {
  const { method, url, headers, ak, sk } = params;

  // STS token header — must be set BEFORE signing so it enters
  // CanonicalizedHeaders (x-obs- prefix → included in signature).
  if (params.securityToken) {
    headers["x-obs-security-token"] = params.securityToken;
  }

  // Date — OBS requires Date (RFC 1123 GMT) or x-obs-date. The server allows
  // ±15 min skew. Caller may pre-set Date; we only fill if missing.
  if (!headers["Date"]) {
    headers["Date"] = new Date().toUTCString();
  }

  // --- Build StringToSign (six segments, \n-separated) ---
  // Segment 1: HTTP-Verb
  let stringToSign = method.toUpperCase() + "\n";

  // Segments 2-4: Content-MD5 / Content-Type / Date — each occupies one line;
  // missing values are empty strings but the trailing \n is always present.
  // SDK doAuth matches header keys with exact case ('Content-MD5' in headers).
  // We use case-insensitive lookup for robustness (HTTP headers are
  // case-insensitive per RFC 7230); our own http.ts always sets canonical case.
  const md5 = findHeader(headers, "content-md5");
  const contentType = findHeader(headers, "content-type");
  const date = findHeader(headers, "date");
  stringToSign += (md5 ?? "") + "\n";
  stringToSign += (contentType ?? "") + "\n";
  stringToSign += (date ?? "") + "\n";

  // Segment 5: CanonicalizedHeaders — all x-obs- prefixed headers, keys
  // lowercased, sorted lexicographically. Meta-prefix (x-obs-meta-) values
  // are trimmed; other x-obs- values are NOT trimmed (matches SDK line 1538).
  const obsHeaders: Array<{ key: string; value: string }> = [];
  for (const [key, value] of Object.entries(headers)) {
    const lowerKey = key.toLowerCase();
    if (lowerKey.startsWith(HEADER_PREFIX)) {
      const isMeta = lowerKey.startsWith(HEADER_META_PREFIX);
      obsHeaders.push({ key: lowerKey, value: isMeta ? value.trim() : value });
    }
  }
  obsHeaders.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  for (const h of obsHeaders) {
    stringToSign += h.key + ":" + h.value + "\n";
  }

  // Segment 6: CanonicalizedResource — path + whitelisted sub-resources.
  // Path is url.pathname as-is (SDK uses opt.uri which is the encoded path).
  // Sub-resources: only keys in ALLOWED_RESOURCE_PARAMETER_NAMES, sorted, joined
  // as key=value with '&', prefixed with '?' if any present. Non-whitelisted
  // query params are ignored.
  stringToSign += canonicalizedResource(url);

  // --- Signature: HMAC-SHA1(sk, stringToSign), base64-encoded ---
  const signature = createHmac("sha1", sk).update(stringToSign, "utf8").digest("base64");

  headers["Authorization"] = "OBS " + ak + ":" + signature;
}

/**
 * Case-insensitive header lookup. HTTP headers are case-insensitive (RFC 7230);
 * our http.ts uses canonical case but callers via openapi_request may not.
 */
function findHeader(headers: Record<string, string>, name: string): string | undefined {
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === lower) return v;
  }
  return undefined;
}

/**
 * CanonicalizedResource: bucket/object path + whitelisted sub-resources.
 *
 * OBS supports two addressing styles:
 *   - Virtual-hosted:  https://<bucket>.obs.<region>.myhuaweicloud.com/<object>
 *                      → host carries the bucket name; pathname is /<object>
 *   - Path-style:      https://obs.<region>.myhuaweicloud.com/<bucket>/<object>
 *                      → pathname carries the bucket name
 *
 * The canonical resource must ALWAYS be `/<bucket>/<object>` regardless of
 * addressing style — the OBS server extracts the bucket from host (virtual-
 * hosted) or path (path-style) when verifying. For virtual-hosted style we
 * must pull the bucket out of the host and prepend it to the pathname,
 * because url.pathname alone would be `/<object>` (missing the bucket).
 *
 * Global endpoints (no bucket in host, e.g. ListAllMyBuckets): canonical
 * resource is just `/` + sub-resources.
 *
 * Sub-resources: query params whose key is in ALLOWED_RESOURCE_PARAMETER_NAMES
 * (case-insensitive), sorted by key, joined as `key=value` with `&`. If a
 * param has no value, it's just `key`. Prefixed with `?` when non-empty.
 * Non-whitelisted query params do NOT enter the canonical resource.
 */
function canonicalizedResource(url: URL): string {
  // Extract bucket from virtual-hosted host: <bucket>.obs.<region>...
  // The bucket is the leading label before ".obs."
  let path = url.pathname || "/";
  const host = url.host;
  const obsIdx = host.indexOf(".obs.");
  if (obsIdx > 0) {
    const bucket = host.slice(0, obsIdx);
    // Virtual-hosted style: canonical resource is /bucket/ when the request
    // targets the bucket root (ListObjects, bucket-level ops), or /bucket/object
    // when targeting an object. SDK's makeParam appends a trailing slash to
    // the uri when the requestUri collapses to "/" (line 1413: `uri += '/'`),
    // so /bucket/ — not /bucket — enters the StringToSign.
    // path is "/" → "/bucket/"; path is "/obj" → "/bucket/obj".
    path = "/" + bucket + (path === "/" ? "/" : path);
  }

  // Collect whitelisted sub-resources.
  const subResources: Array<{ key: string; value: string | null }> = [];
  for (const [key, value] of url.searchParams.entries()) {
    if (ALLOWED_RESOURCE_PARAMETER_NAMES.has(key.toLowerCase())) {
      subResources.push({ key, value: value || null });
    }
  }
  if (subResources.length > 0) {
    subResources.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    const parts = subResources.map((s) => (s.value === null ? s.key : s.key + "=" + s.value));
    path += "?" + parts.join("&");
  }

  return path;
}
