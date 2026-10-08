/**
 * Credential scope — naming and validation (src/auth/scope.ts), plus the
 * derivation store.ts makes from it at module load.
 *
 * The derivation cases matter as much as the parser: they are the regression
 * guard for existing installations. A scope of `default` must keep producing
 * exactly the keychain account and filename that were hardcoded before scopes
 * existed, or an upgrade silently orphans everyone's stored credentials.
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import {
  DEFAULT_SCOPE,
  SCOPE_ENV,
  credentialsFileName,
  keychainAccount,
  parseScope,
} from "../src/auth/scope.js";

describe("parseScope — normalization and default", () => {
  it("defaults when unset or blank", () => {
    expect(parseScope(undefined)).toBe(DEFAULT_SCOPE);
    expect(parseScope("")).toBe(DEFAULT_SCOPE);
    expect(parseScope("   ")).toBe(DEFAULT_SCOPE);
    expect(parseScope("\t\n")).toBe(DEFAULT_SCOPE);
  });

  it("folds case and surrounding whitespace, like parseMode", () => {
    expect(parseScope("dsh")).toBe("dsh");
    expect(parseScope("DSH")).toBe("dsh");
    expect(parseScope("  DsH  ")).toBe("dsh");
  });

  it("accepts the documented identifier shape", () => {
    for (const value of ["dsh", "claude-code", "a", "x1", "a-b_c", "0", "9lives"]) {
      expect(parseScope(value)).toBe(value);
    }
  });

  it("accepts a scope at the length limit and rejects one past it", () => {
    const max = "a".repeat(64);
    expect(parseScope(max)).toBe(max);
    expect(() => parseScope("a".repeat(65))).toThrow(/not a valid credential scope/);
  });

  it("collides case variants by design rather than treating them as distinct", () => {
    // Documented in the README: `DSH` and `dsh` are the same scope. Pinned
    // here so nobody later "fixes" it into case-sensitive matching, which
    // would split one client's credentials across two entries.
    expect(parseScope("DSH")).toBe(parseScope("dsh"));
  });
});

describe("parseScope — an invalid value is fatal", () => {
  // The deliberate divergence from parseMode: this input is a free-form name,
  // so falling back to the default would silently share the keychain with
  // every unset client — the exact confusion scoping exists to remove.
  const invalid: Array<[string, string]> = [
    ["parent traversal", "../x"],
    ["nested traversal", "a/../../b"],
    ["a path separator", "a/b"],
    ["a dot", "a.b"],
    ["a leading dash", "-lead"],
    ["a leading underscore", "_lead"],
    ["an embedded space", "a b"],
    ["a shell metacharacter", "a$b"],
    ["a backslash", "a\\b"],
    ["a null-ish control character", "a\u0000b"],
    ["a non-ASCII letter", "汉"],
    ["an uppercase-only path-ish value", "../DEFAULT"],
  ];

  it.each(invalid)("rejects %s", (_label, value) => {
    expect(() => parseScope(value)).toThrow(/not a valid credential scope/);
  });

  it("names the variable, the rejected value, and the escape hatch", () => {
    // The message is the whole remedy for an operator whose config typo just
    // took the server down, so it has to carry all three.
    let message = "";
    try {
      parseScope("../x");
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain(SCOPE_ENV);
    expect(message).toContain('"../x"');
    expect(message).toContain(DEFAULT_SCOPE);
  });
});

describe("scope → keychain account", () => {
  it("uses the scope as the account", () => {
    expect(keychainAccount("dsh")).toBe("dsh");
    expect(keychainAccount("claude-code")).toBe("claude-code");
  });

  it("keeps the pre-scope account name for the default scope", () => {
    // THE regression guard. `default` is what store.ts hardcoded before this
    // feature; every existing keychain entry is filed under it.
    expect(keychainAccount(DEFAULT_SCOPE)).toBe("default");
  });

  it("separates scopes", () => {
    expect(keychainAccount("a")).not.toBe(keychainAccount("b"));
  });
});

describe("scope → fallback filename", () => {
  it("keeps the original unsuffixed name for the default scope", () => {
    // Same regression guard as above, for the machine-fingerprint file.
    expect(credentialsFileName(DEFAULT_SCOPE)).toBe("credentials.enc");
  });

  it("suffixes other scopes so their files sit side by side", () => {
    expect(credentialsFileName("dsh")).toBe("credentials.dsh.enc");
    expect(credentialsFileName("claude-code")).toBe("credentials.claude-code.enc");
  });

  it("never yields a path separator, for any accepted scope", () => {
    // parseScope already refuses separators; this asserts the second half of
    // the guarantee — that the filename builder does not introduce one.
    for (const value of ["dsh", "a-b_c", "x1"]) {
      const name = credentialsFileName(parseScope(value));
      expect(name).not.toContain("/");
      expect(name).not.toContain("\\");
      expect(name.startsWith(".")).toBe(false);
    }
  });
});

describe("store.ts derives from the environment at module load", () => {
  const origEnv = { ...process.env };

  afterEach(() => {
    delete process.env[SCOPE_ENV];
    Object.assign(process.env, origEnv);
    vi.resetModules();
  });

  /** Import a fresh store module under the current environment. */
  async function loadStore() {
    vi.resetModules();
    return import("../src/auth/store.js");
  }

  it("defaults to the default scope when the variable is unset", async () => {
    delete process.env[SCOPE_ENV];
    const store = await loadStore();
    expect(store.SCOPE).toBe(DEFAULT_SCOPE);
    expect(store.SERVICE).toBe("huaweicloud-ops-deploy");
  });

  it("adopts the configured scope", async () => {
    process.env[SCOPE_ENV] = "dsh";
    const store = await loadStore();
    expect(store.SCOPE).toBe("dsh");
  });

  it("fails at import when the scope is invalid", async () => {
    // "Fails at startup" is the promised behavior, and module load is where
    // startup happens — so this asserts the real seam, not a helper.
    process.env[SCOPE_ENV] = "../escape";
    await expect(loadStore()).rejects.toThrow(/not a valid credential scope/);
  });
});
