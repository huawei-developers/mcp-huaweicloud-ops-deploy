/**
 * Read-only gate.
 *
 * Three things are under test, in descending order of how much damage a bug
 * would do:
 *
 *   1. A mutation must never be permitted in read-only mode. This is the whole
 *      point of the feature; a false permit changes production infrastructure.
 *   2. GET/HEAD stay permitted even for hosts the registry has never heard of
 *      (OBS has no metadata at all), because refusing an object download makes
 *      read-only mode useless.
 *   3. Read-write mode permits everything, including terraform apply/destroy.
 *
 * The classification heuristics are tested against the real generated artifact
 * rather than fixtures, so a registry rebuild that silently reshuffles which
 * operations are allowed shows up here.
 */

import { describe, it, expect, beforeEach, afterEach, afterAll } from "vitest";

import { removeServerBuild, serverEntryPoint } from "./helpers/build-server.js";

import { getMode, resetMode, setMode, parseMode } from "../src/permission/mode.js";
import { denyHttp, denyTool, CLOUD_MUTATING_TOOLS } from "../src/permission/gate.js";
import { isReadOnlyPermitted, registryStatus } from "../src/permission/registry.js";

/** Build a URL for a path on a service host. */
function u(host: string, path: string): URL {
  return new URL(`https://${host}${path}`);
}

const ECS = "ecs.cn-north-4.myhuaweicloud.com";

beforeEach(() => {
  resetMode();
});

afterEach(() => {
  resetMode();
});

// Remove the on-demand build when this file is done. `afterAll` runs inside
// vitest's lifecycle and fires reliably; the `process.once('exit')` hook in
// build-server.ts does not, because vitest terminates its workers rather than
// letting them exit. The git-ignored directory would otherwise accumulate.
afterAll(() => {
  removeServerBuild();
});

describe("permission — mode state", () => {
  it("starts read-only when nothing overrides it", () => {
    // The safe default: a session that is not told otherwise cannot mutate.
    delete process.env["HW_DEFAULT_PERMISSION"];
    resetMode();
    expect(getMode()).toBe("read_only");
  });

  it("accepts the operator spellings of each mode", () => {
    for (const value of ["read_only", "read-only", "READONLY", "ro"]) {
      expect(parseMode(value)).toBe("read_only");
    }
    for (const value of ["read_write", "read-write", "ReadWrite", "rw"]) {
      expect(parseMode(value)).toBe("read_write");
    }
  });

  it("treats an unrecognised value as absent rather than throwing", () => {
    // A typo in the environment must not take the server down; it degrades to
    // the default, which is the safe direction.
    expect(parseMode("readonlyish")).toBeUndefined();
    expect(parseMode("")).toBeUndefined();
    expect(parseMode(undefined)).toBeUndefined();
  });

  it("honours HW_DEFAULT_PERMISSION at startup", () => {
    process.env["HW_DEFAULT_PERMISSION"] = "read_write";
    resetMode();
    expect(getMode()).toBe("read_write");
    delete process.env["HW_DEFAULT_PERMISSION"];
  });

  it("reports the previous mode when setting", async () => {
    const { setMode: set } = await import("../src/permission/mode.js");
    expect(set("read_write")).toBe("read_only");
    expect(set("read_write")).toBe("read_write");
    expect(set("read_only")).toBe("read_write");
  });
});

describe("permission — registry", () => {
  it("loads the generated artifact", () => {
    const status = registryStatus();
    expect(status.error).toBeUndefined();
    expect(status.patterns).toBeGreaterThan(100);
  });

  it("admits GET and HEAD without a lookup", () => {
    // OBS is absent from the API catalog entirely, so these must not consult
    // the registry — else every object download would be refused.
    expect(isReadOnlyPermitted("GET", u("obs.cn-north-4.myhuaweicloud.com", "/bucket/key"))).toEqual({
      allowed: true,
      reason: "safe-method",
    });
    expect(isReadOnlyPermitted("HEAD", u("obs.cn-north-4.myhuaweicloud.com", "/bucket/key")).allowed).toBe(true);
  });

  it("admits a known POST query", () => {
    // `ListResourceInstances` is a query the API happens to spell with POST;
    // the registry records it as a read (registered as
    // `^/v1/[^/]+?/[^/]+?/resource_instances/action$`).
    const decision = isReadOnlyPermitted(
      "POST",
      u("vpcep.cn-north-4.myhuaweicloud.com", "/v1/project/abc/resource_instances/action"),
    );
    expect(decision.reason).toBe("registry-match");
    expect(decision.allowed).toBe(true);
  });

  it("refuses a known mutation", () => {
    // Creating an ECS server is a write; even the exact registered path is not
    // in the read set, so it must be refused.
    const decision = isReadOnlyPermitted("POST", u(ECS, "/v1/abc/cloudservers"));
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("registry-miss");
  });

  it("refuses DELETE unconditionally", () => {
    // No DELETE operation in the catalog classifies as a query.
    const decision = isReadOnlyPermitted("DELETE", u(ECS, "/v1/abc/cloudservers/xyz"));
    expect(decision.allowed).toBe(false);
  });

  it("refuses PUT unconditionally, even on a registered path shape", () => {
    // PUT carries replace semantics. A name-based classifier got this wrong in
    // the dangerous direction twice (ShowHasPipeline, ListTemplatesTwo), which
    // is why the method decides.
    const decision = isReadOnlyPermitted("PUT", u("codeartsrepo.cn-north-4.myhuaweicloud.com", "/v4/repositories/1/pipeline"));
    expect(decision.allowed).toBe(false);
  });

  it("denies an unknown host rather than assuming it is safe", () => {
    const decision = isReadOnlyPermitted("POST", u("unknown-service.cn-north-4.myhuaweicloud.com", "/v1/thing"));
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("registry-miss");
  });

  it("does not match a registered path as a prefix", () => {
    // Patterns are anchored: an unregistered mutation must not ride on a
    // registered read path by sharing a prefix.
    const registered = "/v1/project/abc/resource_instances/action";
    expect(isReadOnlyPermitted("POST", u("vpcep.cn-north-4.myhuaweicloud.com", registered)).allowed).toBe(true);
    expect(
      isReadOnlyPermitted("POST", u("vpcep.cn-north-4.myhuaweicloud.com", `${registered}/extra`)).allowed,
    ).toBe(false);
  });

  it("does not let a placeholder swallow a path separator", () => {
    // `{project_id}` compiles to [^/]+?, so a value containing a slash must not
    // let one registered path absorb another segment.
    const decision = isReadOnlyPermitted(
      "POST",
      u("vpcep.cn-north-4.myhuaweicloud.com", "/v1/project/abc/resource_instances/action"),
    );
    expect(decision.allowed).toBe(true);
    // Same pattern, but the trailing token sits in a different segment.
    expect(
      isReadOnlyPermitted("POST", u("vpcep.cn-north-4.myhuaweicloud.com", "/v1/project/abc/resource_instances/x/action"))
        .allowed,
    ).toBe(false);
  });
});

describe("permission — tool gate", () => {
  it("refuses apply and destroy in read-only mode", () => {
    expect(denyTool("terraform_apply")).toBeDefined();
    expect(denyTool("terraform_destroy")).toBeDefined();
  });

  it("allows the terraform tools that only inspect", () => {
    // plan/refresh/import/state/install write local files but do not change
    // cloud state; refusing them would make read-only mode useless for
    // reviewing a change before approving it.
    for (const tool of [
      "terraform_plan",
      "terraform_refresh",
      "terraform_import",
      "terraform_state",
      "terraform_install",
      "terraform_init",
      "provider_schema",
      "terraform_examples_export",
    ]) {
      expect(denyTool(tool), `${tool} should stay available`).toBeUndefined();
    }
  });

  it("allows tools that are not cloud mutations", () => {
    for (const tool of ["apiexplorer", "openapi_request", "auth", "list_existing_resources", "update_cost"]) {
      expect(denyTool(tool)).toBeUndefined();
    }
  });

  it("allows everything once read-write is set", () => {
    setMode("read_write");
    for (const tool of CLOUD_MUTATING_TOOLS) expect(denyTool(tool)).toBeUndefined();
  });

  it("names the gate that refused and how to lift it", () => {
    const message = denyTool("terraform_apply");
    expect(message).toContain("terraform_apply");
    expect(message).toContain("read-only");
    // The model must learn that it cannot lift this itself.
    expect(message).toMatch(/outside this conversation|client UI/);
  });
});

describe("permission — terraform funnel", () => {
  /**
   * The tool-level gate names the tools explicitly, so a unit test on
   * `denyTool` cannot prove a *call site* is wired. These cases drive the real
   * tool handlers over a real MCP connection, which is the only thing that
   * catches a missing name at a registration.
   */
  it("refuses apply and destroy through their real tool registrations", async () => {
    const { Client } = await import("@modelcontextprotocol/client");
    const { StdioClientTransport } = await import("@modelcontextprotocol/client/stdio");
    const client = new Client(
      { name: "test", version: "1" },
      { capabilities: {}, versionNegotiation: { mode: "auto" } } as never,
    );
    await client.connect(new StdioClientTransport({
      command: "node",
      // Compiled on demand — `npm test` does not build, and `npm run build`
      // would additionally require the git-ignored terraform-examples.zip.
      args: [serverEntryPoint()],
      env: { PATH: process.env["PATH"] ?? "", HW_REGION_NAME: "cn-north-4" },
    }));

    try {
      for (const tool of ["terraform_apply", "terraform_destroy"]) {
        const result = await client.callTool({ name: tool, arguments: { deployment: "/tmp/nonexistent" } });
        expect(result.isError, `${tool} must be refused`).toBe(true);
        expect((result.content as Array<{ text: string }>)[0]?.text).toContain("read-only mode");
      }

      // The read-only members of the family must NOT be caught by the gate.
      for (const tool of ["terraform_refresh", "terraform_state", "terraform_plan"]) {
        const result = await client.callTool({ name: tool, arguments: { deployment: "/tmp/nonexistent" } });
        expect((result.content as Array<{ text: string }>)[0]?.text ?? "", `${tool} must not be gate-refused`)
          .not.toContain("read-only mode");
      }
    } finally {
      await client.close();
    }
  });
});

describe("permission — terraform funnel predicate", () => {
  /**
   * `runTerraform` is the single funnel for every terraform invocation, so the
   * predicate there is what protects call sites that do not exist yet.
   *
   * A permitted invocation resolves (and fails to spawn, since no binary is
   * installed), while a refused one throws before any process starts. Both
   * outcomes are reduced to text so a case can assert on which happened.
   */
  async function outcome(argv: string[]): Promise<string> {
    const { runTerraform } = await import("../src/tools/terraform.js");
    try {
      const result = await runTerraform("/tmp/nonexistent", argv);
      return `resolved: ${result.stderr}`;
    } catch (error) {
      return `threw: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  it("refuses a bare apply and destroy, allows a refresh-only apply", async () => {
    expect(await outcome(["apply", "-auto-approve"])).toMatch(/threw: .*read-only mode/);
    expect(await outcome(["destroy", "-auto-approve"])).toMatch(/threw: .*read-only mode/);
    // -refresh-only reconciles local state and changes nothing in the account —
    // the same "reads are fine" rule the HTTP gate applies to GET. Losing this
    // flag is exactly the edit that would turn a read into a write.
    expect(await outcome(["apply", "-refresh-only", "-auto-approve"])).not.toMatch(/read-only mode/);
  });

  it("leaves plan, init, show and import alone", async () => {
    for (const argv of [["init"], ["plan", "-json"], ["show", "-json"], ["import", "a.b", "id"]]) {
      expect(await outcome(argv), argv.join(" ")).not.toMatch(/read-only mode/);
    }
  });

  it("permits everything once read-write is set", async () => {
    setMode("read_write");
    expect(await outcome(["apply", "-auto-approve"])).not.toMatch(/read-only mode/);
    expect(await outcome(["destroy", "-auto-approve"])).not.toMatch(/read-only mode/);
  });
});

describe("permission — HTTP gate", () => {
  it("refuses a mutation in read-only mode, and permits it in read-write", () => {
    const url = u(ECS, "/v1/abc/cloudservers");
    expect(denyHttp("POST", url)).toBeDefined();
    setMode("read_write");
    expect(denyHttp("POST", url)).toBeUndefined();
  });

  it("permits GET regardless of mode", () => {
    expect(denyHttp("GET", u(ECS, "/v1/abc/cloudservers/detail"))).toBeUndefined();
    setMode("read_write");
    expect(denyHttp("GET", u(ECS, "/v1/abc/cloudservers/detail"))).toBeUndefined();
  });

  it("distinguishes an unknown operation from a known write in the message", () => {
    const message = denyHttp("DELETE", u(ECS, "/v1/abc/cloudservers/xyz"));
    expect(message).toContain("DELETE");
    expect(message).toMatch(/not a\s+known read-only operation/);
  });
});

describe("permission — signedHttp is gated unconditionally", () => {
  /** Credentials that make it past signing without touching the keychain. */
  const CREDS = { ak: "AK", sk: "SK", region: "cn-north-4" };

  it("refuses a mutation even when credentials are passed explicitly", async () => {
    // The gate used to be skipped whenever `creds` was supplied, which keyed an
    // exemption on a parameter's shape rather than on what the request does.
    // Nothing depended on it — the only such callers are GETs — so it was
    // removed; this pins that it stays removed.
    const { signedHttp } = await import("../src/auth/http.js");
    await expect(
      signedHttp("POST", u(ECS, "/v1/abc/cloudservers"), "", {}, CREDS),
    ).rejects.toThrow(/read-only mode/);
    await expect(
      signedHttp("DELETE", u(ECS, "/v1/abc/cloudservers/xyz"), "", {}, CREDS),
    ).rejects.toThrow(/read-only mode/);
  });

  it("still admits the GET that credential verification uses", async () => {
    // auth/iam.ts verifies credentials with a GET through signedHttp. Whatever
    // the gate does, that must keep working — it is why removing the exemption
    // is safe.
    const { signedHttp } = await import("../src/auth/http.js");
    // Passes the gate, then fails on the network (unresolvable host) — which is
    // proof it was admitted rather than refused.
    await expect(
      signedHttp("GET", u("iam.invalid-region-xyz.myhuaweicloud.com", "/v3/auth/domains"), "", {}, CREDS),
    ).rejects.not.toThrow(/read-only mode/);
  });
});