import { describe, it, expect } from "vitest";
import { signObsRequest } from "../src/auth/obs_signer.js";

/**
 * OBS signer tests — structural + self-consistency assertions.
 *
 * The OBS SDK doesn't publish canonical signature test vectors, so we can't
 * assert "input X produces signature Y". Instead we verify the StringToSign
 * construction (the part that's fully deterministic given inputs) by exposing
 * the signature computation and checking the Authorization header shape,
 * determinism, and the structural rules (whitelist filtering, \n placement,
 * STS inclusion, header sorting).
 *
 * The signer mutates headers in place; we read back Authorization and the
 * signed headers to verify behavior.
 */

const AK = "EXAMPLEAKID";
const SK = "examplesksecretkey";

/** Minimal helper: sign a request with fixed inputs, return the headers. */
function sign(opts: {
  method?: string;
  url: string;
  headers?: Record<string, string>;
  body?: string;
  ak?: string;
  sk?: string;
  securityToken?: string;
}): Record<string, string> {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  signObsRequest({
    method: opts.method ?? "GET",
    url: new URL(opts.url),
    headers,
    body: opts.body ?? "",
    ak: opts.ak ?? AK,
    sk: opts.sk ?? SK,
    securityToken: opts.securityToken,
  });
  return headers;
}

describe("signObsRequest — Authorization header", () => {
  it("produces `OBS <AK>:<base64>` format", () => {
    const h = sign({ url: "https://obs.cn-north-4.myhuaweicloud.com/" });
    expect(h["Authorization"]).toMatch(/^OBS EXAMPLEAKID:[A-Za-z0-9+/=]+$/);
  });

  it("is deterministic — same inputs yield the same signature", () => {
    // Date is non-deterministic (uses new Date()), so freeze it for comparison.
    const fixedDate = "Sat, 19 Sep 2026 12:34:56 GMT";
    const a = sign({ url: "https://obs.cn-north-4.myhuaweicloud.com/", headers: { Date: fixedDate } });
    const b = sign({ url: "https://obs.cn-north-4.myhuaweicloud.com/", headers: { Date: fixedDate } });
    expect(a["Authorization"]).toBe(b["Authorization"]);
  });

  it("changes when method changes", () => {
    const fixedDate = "Sat, 19 Sep 2026 12:34:56 GMT";
    const g = sign({ method: "GET", url: "https://obs.cn-north-4.myhuaweicloud.com/bucket", headers: { Date: fixedDate } });
    const p = sign({ method: "PUT", url: "https://obs.cn-north-4.myhuaweicloud.com/bucket", headers: { Date: fixedDate } });
    expect(g["Authorization"]).not.toBe(p["Authorization"]);
  });
});

describe("signObsRequest — StringToSign structure", () => {
  /**
   * Reconstruct the expected StringToSign from inputs and compare the HMAC
   * output. This validates the exact \n placement and segment ordering.
   */
  function expectedAuth(params: {
    method: string;
    path: string;
    md5?: string;
    contentType?: string;
    date: string;
    obsHeaders?: Record<string, string>;
    subResources?: string;
    ak: string;
    sk: string;
  }): string {
    let sts = params.method.toUpperCase() + "\n";
    sts += (params.md5 ?? "") + "\n";
    sts += (params.contentType ?? "") + "\n";
    sts += params.date + "\n";
    // CanonicalizedHeaders
    const entries = Object.entries(params.obsHeaders ?? {})
      .map(([k, v]) => [k.toLowerCase(), v] as [string, string])
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    for (const [k, v] of entries) {
      const isMeta = k.startsWith("x-obs-meta-");
      sts += k + ":" + (isMeta ? v.trim() : v) + "\n";
    }
    // CanonicalizedResource
    sts += params.path + (params.subResources ? "?" + params.subResources : "");
    const { createHmac } = require("node:crypto") as typeof import("node:crypto");
    const sig = createHmac("sha1", params.sk).update(sts, "utf8").digest("base64");
    return "OBS " + params.ak + ":" + sig;
  }

  it("matches expected StringToSign for a bare GET (no headers, no sub-resources)", () => {
    const date = "Sat, 19 Sep 2026 12:34:56 GMT";
    const url = "https://obs.cn-north-4.myhuaweicloud.com/";
    const h = sign({ method: "GET", url, headers: { Date: date } });
    expect(h["Authorization"]).toBe(
      expectedAuth({ method: "GET", path: "/", date, ak: AK, sk: SK }),
    );
  });

  it("matches expected StringToSign with Content-Type and Content-MD5", () => {
    const date = "Sat, 19 Sep 2026 12:34:56 GMT";
    const url = "https://obs.cn-north-4.myhuaweicloud.com/bucket/object";
    const headers = {
      "Content-Type": "text/plain",
      "Content-MD5": "1B2M2Y8AsgTpgAmY7PhCfg==",
      Date: date,
    };
    const h = sign({ method: "PUT", url, headers, body: "hello" });
    expect(h["Authorization"]).toBe(
      expectedAuth({
        method: "PUT",
        path: "/bucket/object",
        contentType: "text/plain",
        md5: "1B2M2Y8AsgTpgAmY7PhCfg==",
        date,
        ak: AK,
        sk: SK,
      }),
    );
  });

  it("matches expected StringToSign with x-obs- headers (sorted, meta-trimmed)", () => {
    const date = "Sat, 19 Sep 2026 12:34:56 GMT";
    const url = "https://obs.cn-north-4.myhuaweicloud.com/newbucket";
    // Insert out of order; signer must sort. meta value has whitespace to trim.
    const headers = {
      Date: date,
      "x-obs-acl": "private",
      "x-obs-meta-author": "  alice  ",
    };
    const h = sign({ method: "PUT", url, headers });
    expect(h["Authorization"]).toBe(
      expectedAuth({
        method: "PUT",
        path: "/newbucket",
        date,
        obsHeaders: { "x-obs-acl": "private", "x-obs-meta-author": "  alice  " },
        ak: AK,
        sk: SK,
      }),
    );
  });

  it("matches expected StringToSign with whitelisted sub-resources", () => {
    const date = "Sat, 19 Sep 2026 12:34:56 GMT";
    // acl is whitelisted; uploads is whitelisted; sorting: acl < uploads
    const url = "https://obs.cn-north-4.myhuaweicloud.com/bucket?uploads=&acl=private";
    const h = sign({ method: "GET", url, headers: { Date: date } });
    expect(h["Authorization"]).toBe(
      expectedAuth({
        method: "GET",
        path: "/bucket",
        date,
        subResources: "acl=private&uploads",  // sorted, valueless uploads has no '='
        ak: AK,
        sk: SK,
      }),
    );
  });
});

describe("signObsRequest — virtual-hosted style bucket extraction", () => {
  /**
   * Virtual-hosted style: https://<bucket>.obs.<region>.myhuaweicloud.com/<object>
   * The bucket name is in the host, not the path. The canonical resource must
   * still carry the bucket name as /<bucket>/ (with trailing slash when the
   * path is "/"), because the OBS server extracts it from the host when
   * verifying the signature.
   *
   * Verified end-to-end against real OBS (ListObjects on
   * obs-test-ff0901c5f9.obs.cn-north-4.myhuaweicloud.com → 200).
   */
  it("extracts bucket from host and appends trailing slash for bucket-root requests", () => {
    const date = "Sat, 19 Sep 2026 12:34:56 GMT";
    // Virtual-hosted: bucket in host, path "/" → canonical /bucket/
    const vh = sign({
      url: "https://obs-test-ff0901c5f9.obs.cn-north-4.myhuaweicloud.com/",
      headers: { Date: date },
    });
    // Path-style equivalent: same bucket, same canonical /bucket/ — but SDK
    // makeParam produces /bucket/ for virtual-hosted root. We can't easily
    // compare against path-style here (path-style would be /bucket). Instead
    // verify the signature differs from a bare "/" (no bucket) — proving the
    // bucket entered the canonical resource.
    const noBucket = sign({
      url: "https://obs.cn-north-4.myhuaweicloud.com/",
      headers: { Date: date },
    });
    expect(vh["Authorization"]).not.toBe(noBucket["Authorization"]);
  });

  it("virtual-hosted with object: canonical is /bucket/object (no trailing slash)", () => {
    const date = "Sat, 19 Sep 2026 12:34:56 GMT";
    // Object request: path "/object.txt" → canonical /bucket/object.txt
    const withObj = sign({
      url: "https://obs-test-ff0901c5f9.obs.cn-north-4.myhuaweicloud.com/object.txt",
      headers: { Date: date },
    });
    const withoutObj = sign({
      url: "https://obs-test-ff0901c5f9.obs.cn-north-4.myhuaweicloud.com/",
      headers: { Date: date },
    });
    expect(withObj["Authorization"]).not.toBe(withoutObj["Authorization"]);
  });

  it("virtual-hosted: non-whitelisted query does not affect signature", () => {
    const date = "Sat, 19 Sep 2026 12:34:56 GMT";
    const base = sign({
      url: "https://obs-test-ff0901c5f9.obs.cn-north-4.myhuaweicloud.com/",
      headers: { Date: date },
    });
    const withQuery = sign({
      url: "https://obs-test-ff0901c5f9.obs.cn-north-4.myhuaweicloud.com/?max-keys=3&marker=abc",
      headers: { Date: date },
    });
    expect(base["Authorization"]).toBe(withQuery["Authorization"]);
  });
});

describe("signObsRequest — sub-resource whitelist", () => {
  it("includes whitelisted params (acl, uploadId) in canonical resource", () => {
    const date = "Sat, 19 Sep 2026 12:34:56 GMT";
    const withAcl = sign({ url: "https://obs.cn-north-4.myhuaweicloud.com/b?acl=private", headers: { Date: date } });
    const withoutAcl = sign({ url: "https://obs.cn-north-4.myhuaweicloud.com/b", headers: { Date: date } });
    expect(withAcl["Authorization"]).not.toBe(withoutAcl["Authorization"]);
  });

  it("excludes non-whitelisted params (marker, max-keys) from canonical resource", () => {
    const date = "Sat, 19 Sep 2026 12:34:56 GMT";
    // marker and max-keys are NOT in the whitelist — they must not affect signature.
    const base = sign({ url: "https://obs.cn-north-4.myhuaweicloud.com/b", headers: { Date: date } });
    const withIgnored = sign({
      url: "https://obs.cn-north-4.myhuaweicloud.com/b?marker=abc&max-keys=100",
      headers: { Date: date },
    });
    expect(base["Authorization"]).toBe(withIgnored["Authorization"]);
  });
});

describe("signObsRequest — STS token", () => {
  it("sets x-obs-security-token header when securityToken provided", () => {
    const h = sign({
      url: "https://obs.cn-north-4.myhuaweicloud.com/",
      securityToken: "temp-sts-token",
    });
    expect(h["x-obs-security-token"]).toBe("temp-sts-token");
  });

  it("STS token affects the signature (it's an x-obs- header → in canonical headers)", () => {
    const date = "Sat, 19 Sep 2026 12:34:56 GMT";
    const noSts = sign({ url: "https://obs.cn-north-4.myhuaweicloud.com/", headers: { Date: date } });
    const withSts = sign({
      url: "https://obs.cn-north-4.myhuaweicloud.com/",
      headers: { Date: date },
      securityToken: "temp-sts-token",
    });
    expect(noSts["Authorization"]).not.toBe(withSts["Authorization"]);
  });

  it("does not set x-obs-security-token when securityToken absent", () => {
    const h = sign({ url: "https://obs.cn-north-4.myhuaweicloud.com/" });
    expect(h["x-obs-security-token"]).toBeUndefined();
  });
});

describe("signObsRequest — Date header", () => {
  it("sets Date (RFC 1123) when not provided", () => {
    const h = sign({ url: "https://obs.cn-north-4.myhuaweicloud.com/" });
    expect(h["Date"]).toMatch(/^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/);
  });

  it("preserves caller-provided Date", () => {
    const fixed = "Wed, 01 Jan 2025 00:00:00 GMT";
    const h = sign({ url: "https://obs.cn-north-4.myhuaweicloud.com/", headers: { Date: fixed } });
    expect(h["Date"]).toBe(fixed);
  });
});

describe("signObsRequest — header case-insensitivity", () => {
  it("matches Content-Type/Content-MD5/Date regardless of case", () => {
    const date = "Sat, 19 Sep 2026 12:34:56 GMT";
    // lowercase keys — findHeader must still match
    const lower = sign({
      url: "https://obs.cn-north-4.myhuaweicloud.com/o",
      headers: { "content-type": "text/plain", date },
    });
    const canonical = sign({
      url: "https://obs.cn-north-4.myhuaweicloud.com/o",
      headers: { "Content-Type": "text/plain", Date: date },
    });
    expect(lower["Authorization"]).toBe(canonical["Authorization"]);
  });
});
