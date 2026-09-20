import { describe, it, expect, afterEach, vi } from "vitest";
import { readEnvCredentials, handleAuth } from "../src/tools/auth.js";
import type { ToolCtx } from "../src/tools/errors.js";
import { isInputRequiredResult } from "@modelcontextprotocol/server";

describe("readEnvCredentials", () => {
  const origEnv = { ...process.env };

  afterEach(() => {
    for (const k of ["HW_ACCESS_KEY", "HW_SECRET_KEY", "HW_REGION_NAME", "HW_SECURITY_TOKEN"]) {
      delete process.env[k];
    }
    Object.assign(process.env, origEnv);
  });

  it("returns null when any required var is missing", () => {
    process.env["HW_ACCESS_KEY"] = "ak";
    process.env["HW_SECRET_KEY"] = "sk";
    // HW_REGION_NAME missing
    expect(readEnvCredentials()).toBeNull();
  });

  it("returns null when only ak is set", () => {
    process.env["HW_ACCESS_KEY"] = "ak";
    expect(readEnvCredentials()).toBeNull();
  });

  it("returns creds when all three required vars are set", () => {
    process.env["HW_ACCESS_KEY"] = "ak";
    process.env["HW_SECRET_KEY"] = "sk";
    process.env["HW_REGION_NAME"] = "cn-north-4";
    const c = readEnvCredentials();
    expect(c).toEqual({ ak: "ak", sk: "sk", region: "cn-north-4" });
  });

  it("includes security_token when HW_SECURITY_TOKEN is set", () => {
    process.env["HW_ACCESS_KEY"] = "ak";
    process.env["HW_SECRET_KEY"] = "sk";
    process.env["HW_REGION_NAME"] = "cn-north-4";
    process.env["HW_SECURITY_TOKEN"] = "sts";
    const c = readEnvCredentials();
    expect(c?.security_token).toBe("sts");
  });

  it("does not include security_token when HW_SECURITY_TOKEN is absent", () => {
    process.env["HW_ACCESS_KEY"] = "ak";
    process.env["HW_SECRET_KEY"] = "sk";
    process.env["HW_REGION_NAME"] = "cn-north-4";
    const c = readEnvCredentials();
    expect(c?.security_token).toBeUndefined();
  });

  it("reads HW_REGION_NAME (not HW_REGION)", () => {
    process.env["HW_ACCESS_KEY"] = "ak";
    process.env["HW_SECRET_KEY"] = "sk";
    process.env["HW_REGION"] = "cn-north-4"; // wrong name
    // HW_REGION_NAME not set
    expect(readEnvCredentials()).toBeNull();
  });
});

describe("handleAuth — elicitation decline/cancel/accept", () => {
  const origEnv = { ...process.env };

  // Minimal server mock: getClientCapabilities returns elicitation support.
  const makeServer = (elicitation: boolean) =>
    ({ getClientCapabilities: () => (elicitation ? { elicitation: {} } : {}) }) as unknown as
      Parameters<typeof handleAuth>[1];

  // Minimal ctx mock: only mcpReq.inputResponses matters for the second leg.
  const makeCtx = (inputResponses: Record<string, unknown> | undefined): ToolCtx =>
    ({ mcpReq: { id: 1, method: "tools/call", inputResponses } }) as unknown as ToolCtx;

  afterEach(() => {
    for (const k of ["HW_ACCESS_KEY", "HW_SECRET_KEY", "HW_REGION_NAME", "HW_SECURITY_TOKEN"]) {
      delete process.env[k];
    }
    Object.assign(process.env, origEnv);
  });

  it("decline returns a terminal fail result, NOT inputRequired (no re-emit)", async () => {
    const ctx = makeCtx({ credentials: { action: "decline" } });
    const result = await handleAuth(ctx, makeServer(true));
    expect(isInputRequiredResult(result)).toBe(false);
    // It must be an error result the LLM sees, not a form re-emit.
    const content = (result as { content?: { text?: string }[] }).content;
    expect(content?.[0]?.text).toContain("取消");
  });

  it("cancel returns a terminal fail result, NOT inputRequired (no re-emit)", async () => {
    const ctx = makeCtx({ credentials: { action: "cancel" } });
    const result = await handleAuth(ctx, makeServer(true));
    expect(isInputRequiredResult(result)).toBe(false);
  });

  it("first leg (missing inputResponses) returns inputRequired (the form)", async () => {
    const ctx = makeCtx(undefined);
    const result = await handleAuth(ctx, makeServer(true));
    expect(isInputRequiredResult(result)).toBe(true);
  });

  it("accept with valid content calls persistAndVerify (not inputRequired)", async () => {
    // Mock verifyCredentials via the IAM module so no real HTTP call is made.
    const iam = await import("../src/auth/iam.js");
    vi.spyOn(iam, "verifyCredentials").mockResolvedValue({
      ok: true,
      account: { account_id: "id", name: "acct", project_id: "pid" },
    });
    const store = await import("../src/auth/store.js");
    vi.spyOn(store, "saveCredentials").mockResolvedValue(undefined);

    const ctx = makeCtx({
      credentials: { action: "accept", content: { ak: "AK", sk: "SK", region: "cn-north-4" } },
    });
    const result = await handleAuth(ctx, makeServer(true));
    expect(isInputRequiredResult(result)).toBe(false);
    const text = (result as { content?: { text?: string }[] }).content?.[0]?.text ?? "";
    expect(text).toContain("authenticated");
    vi.restoreAllMocks();
  });
});
