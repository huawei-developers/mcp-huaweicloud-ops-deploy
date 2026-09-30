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
    // Shape MUST match VerifiedResult — tsconfig.test.json type-checks this
    // (a prior mismatch with project_id→projects silently passed because tsc
    // excluded test/ and vitest ignores types).
    const iam = await import("../src/auth/iam.js");
    vi.spyOn(iam, "verifyCredentials").mockResolvedValue({
      ok: true,
      account: { account_id: "id", name: "acct", projects: [{ id: "pid", name: "cn-north-4" }] },
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
    // Verify the projects list flows through to the tool output (not just
    // "authenticated" — the prior mock returned projects: undefined silently).
    expect(text).toContain("projects");
    const parsed = JSON.parse(text) as { projects?: unknown[] };
    expect(parsed.projects).toHaveLength(1);
    vi.restoreAllMocks();
  });
});

/**
 * Regression: capability detection must read the 2026-07-28 per-request
 * envelope.
 *
 * On that era `Server.getClientCapabilities()` returns undefined — it reads
 * `initialize`-scoped state the era never populates — so probing only that
 * accessor made every modern-era client look uninitialized and `auth`
 * answered "server not initialized — client must complete initialize before
 * calling tools" while the rest of the session worked fine. In the field this
 * surfaced as the auth tool being permanently unusable from any client that
 * negotiated 2026-07-28 (e.g. DSH), with a message that pointed at the client
 * rather than at this probe.
 */
describe("handleAuth — 2026-07-28 era capability detection", () => {
  // Modern-era server mock: the deprecated accessor is undefined, exactly as
  // the SDK behaves on this era. Capabilities live on the envelope instead.
  const makeModernServer = () =>
    ({ getClientCapabilities: () => undefined }) as unknown as Parameters<typeof handleAuth>[1];

  /** Build a ctx whose envelope carries the given client capabilities. */
  const makeModernCtx = (capabilities: unknown): ToolCtx =>
    ({
      mcpReq: {
        id: 1,
        method: "tools/call",
        inputResponses: undefined,
        envelope: { "io.modelcontextprotocol/clientCapabilities": capabilities },
      },
    }) as unknown as ToolCtx;

  it("uses the envelope when the initialize-scoped accessor is empty", async () => {
    // Envelope declares elicitation -> must take the elicitation path and
    // return the form, NOT the "server not initialized" refusal.
    const result = await handleAuth(makeModernCtx({ elicitation: {} }), makeModernServer());
    expect(isInputRequiredResult(result)).toBe(true);
  });

  it("degrades to env vars when the envelope omits elicitation", async () => {
    const origAk = process.env["HW_ACCESS_KEY"];
    const origSk = process.env["HW_SECRET_KEY"];
    delete process.env["HW_ACCESS_KEY"];
    delete process.env["HW_SECRET_KEY"];
    try {
      // No elicitation in the envelope and no env credentials -> the explicit
      // "client does not support elicitation" message, never the misleading
      // "server not initialized" one.
      const result = await handleAuth(makeModernCtx({}), makeModernServer());
      expect(isInputRequiredResult(result)).toBe(false);
      const text = (result as { content?: { text?: string }[] }).content?.[0]?.text ?? "";
      expect(text).toContain("elicitation");
      expect(text).not.toContain("server not initialized");
    } finally {
      if (origAk !== undefined) process.env["HW_ACCESS_KEY"] = origAk;
      if (origSk !== undefined) process.env["HW_SECRET_KEY"] = origSk;
    }
  });

  it("still refuses when neither the envelope nor initialize carries capabilities", async () => {
    const ctx = { mcpReq: { id: 1, method: "tools/call", inputResponses: undefined } } as unknown as ToolCtx;
    const result = await handleAuth(ctx, makeModernServer());
    const text = (result as { content?: { text?: string }[] }).content?.[0]?.text ?? "";
    expect(text).toContain("server not initialized");
  });
});
