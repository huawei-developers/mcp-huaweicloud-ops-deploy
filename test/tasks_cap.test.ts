import { describe, it, expect } from "vitest";
import { clientHasTasksCap, tasksCapFromCaps } from "../src/tools/terraform.js";
import type { ToolCtx } from "../src/tools/errors.js";
import type { ClientCapabilities } from "@modelcontextprotocol/server";

/**
 * SDK 2.0.0 has no task runtime: `CreateTaskResult` is @deprecated "2025-11-25
 * wire vocabulary with no SDK runtime", and `taskToResult` puts `resultType:
 * "task"` in `structuredContent` where neither era's codec looks (both read
 * the top-level `result["resultType"]`, stamp/strip it, and return `complete`).
 * So `clientHasTasksCap` returns false — the long-running terraform tools use
 * the synchronous + progress-notifications fallback regardless of the client's
 * declared capability.
 *
 * `tasksCapFromCaps` is the era-aware capability read kept for a future SDK
 * with a real task runtime (re-enabling the task path is a one-line change in
 * `clientHasTasksCap`). Its logic is covered here so the future re-enablement
 * starts from verified code.
 */
describe("clientHasTasksCap — returns false under SDK 2.0.0", () => {
  it("returns false even when the envelope declares tasks support", () => {
    const ctx = {
      mcpReq: {
        id: 1,
        method: "tools/call",
        inputResponses: undefined,
        envelope: { "io.modelcontextprotocol/clientCapabilities": { extensions: { "io.modelcontextprotocol/tasks": {} } } },
      },
    } as unknown as ToolCtx;
    expect(clientHasTasksCap(ctx)).toBe(false);
  });

  it("returns false with no context", () => {
    expect(clientHasTasksCap(undefined)).toBe(false);
  });
});

describe("tasksCapFromCaps — era-aware read (kept for future re-enablement)", () => {
  it("detects tasks via the extension", () => {
    const caps = { extensions: { "io.modelcontextprotocol/tasks": {} } } as unknown as ClientCapabilities;
    expect(tasksCapFromCaps(caps)).toBe(true);
  });

  it("detects tasks via the core field (legacy/Inspector)", () => {
    const caps = { tasks: { list: {} } } as unknown as ClientCapabilities;
    expect(tasksCapFromCaps(caps)).toBe(true);
  });

  it("returns false when neither tasks nor the extension is declared", () => {
    const caps = { elicitation: {} } as unknown as ClientCapabilities;
    expect(tasksCapFromCaps(caps)).toBe(false);
  });
});
