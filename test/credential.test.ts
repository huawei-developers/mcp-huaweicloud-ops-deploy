/**
 * credential/reset — clearCredentials (src/auth/store.ts) and the
 * credential/reset custom method (src/credential/methods.ts).
 *
 * clearCredentials is tested directly because it owns the layer-clearing
 * logic (session, keychain, file, env detection). The custom-method wrapper
 * is tested over a real MCP connection, because that is the only thing that
 * proves the registration is wired and the method is era-blind.
 */

import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { z } from "zod";

import { clearCredentials, saveCredentials, SCOPE } from "../src/auth/store.js";
import { credentialsFileName, keychainAccount } from "../src/auth/scope.js";
import { tryKeychainGet } from "../src/auth/keychain.js";
import { fingerprintDecrypt, fingerprintEncrypt } from "../src/auth/fingerprint.js";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const CREDS_DIR = join(homedir(), ".huaweicloud-ops-deploy");
const CREDS_FILE = join(CREDS_DIR, credentialsFileName(SCOPE));
const PERM_CREDS = { ak: "AK_TEST", sk: "SK_TEST", region: "cn-north-4" };

/** Remove the test's credentials file if a previous run left it. */
async function cleanFile(): Promise<void> {
  await rm(CREDS_FILE, { force: true });
}

beforeEach(async () => {
  await cleanFile();
});

afterEach(async () => {
  await cleanFile();
});

describe("clearCredentials — persisted layers", () => {
  it("removes a fingerprint fallback file written for this scope", async () => {
    // Write a file directly, as the fallback path would.
    const encrypted = await fingerprintEncrypt(JSON.stringify(PERM_CREDS));
    await mkdir(CREDS_DIR, { recursive: true });
    await writeFile(CREDS_FILE, encrypted);
    await expect(readFile(CREDS_FILE)).resolves.toBeDefined();

    const result = await clearCredentials();
    expect(result.file).toBe(true);
    await expect(readFile(CREDS_FILE)).rejects.toThrow(/ENOENT/);
  });

  it("reports file=true when the file was already absent", async () => {
    // No file written — clearCredentials must not treat absence as failure.
    const result = await clearCredentials();
    expect(result.file).toBe(true);
  });

  it("is idempotent — a second reset finds nothing to remove", async () => {
    const first = await clearCredentials();
    const second = await clearCredentials();
    expect(second.file).toBe(true);
    expect(second.keychain).toBe(first.keychain);
  });
});

describe("clearCredentials — keychain", () => {
  it("deletes a keychain entry that saveCredentials wrote", async () => {
    // The keychain is unavailable in CI/headless environments; without a
    // keyring the binding never loads and tryKeychainGet returns null. Nothing
    // was written to delete, so the test is a no-op there rather than a false
    // negative — the file-layer tests cover the delete path.
    const present = await tryKeychainGet("huaweicloud-ops-deploy", keychainAccount(SCOPE));
    if (present === null) return;

    await saveCredentials(PERM_CREDS, { account_id: "aid", account_name: "an" });
    expect(await tryKeychainGet("huaweicloud-ops-deploy", keychainAccount(SCOPE))).not.toBeNull();

    const result = await clearCredentials();
    expect(result.keychain).toBe(true);
    expect(await tryKeychainGet("huaweicloud-ops-deploy", keychainAccount(SCOPE))).toBeNull();
  });
});

describe("clearCredentials — env detection", () => {
  const KEYS = ["HW_ACCESS_KEY", "HW_SECRET_KEY", "HW_REGION_NAME"] as const;
  const orig = KEYS.map((k) => process.env[k]);

  afterEach(() => {
    KEYS.forEach((k, i) => {
      if (orig[i] === undefined) delete process.env[k];
      else process.env[k] = orig[i];
    });
  });

  it("reports env_active=true when all three env vars are set", async () => {
    process.env["HW_ACCESS_KEY"] = "ak";
    process.env["HW_SECRET_KEY"] = "sk";
    process.env["HW_REGION_NAME"] = "cn-north-4";
    const result = await clearCredentials();
    expect(result.env_active).toBe(true);
  });

  it("reports env_active=false when any env var is missing", async () => {
    delete process.env["HW_ACCESS_KEY"];
    delete process.env["HW_SECRET_KEY"];
    delete process.env["HW_REGION_NAME"];
    const result = await clearCredentials();
    expect(result.env_active).toBe(false);
  });

  it("reports env_active=false when only some env vars are set", async () => {
    process.env["HW_ACCESS_KEY"] = "ak";
    delete process.env["HW_SECRET_KEY"];
    delete process.env["HW_REGION_NAME"];
    const result = await clearCredentials();
    expect(result.env_active).toBe(false);
  });
});

describe("clearCredentials — result shape", () => {
  it("returns the scope and never a credential value", async () => {
    const result = await clearCredentials();
    expect(result.scope).toBe(SCOPE);
    // The result type has no ak/sk/security_token field — assert by absence.
    expect(result).not.toHaveProperty("ak");
    expect(result).not.toHaveProperty("sk");
    expect(result).not.toHaveProperty("security_token");
  });
});

describe("credential/reset — custom method over a real connection", () => {
  /**
   * A unit test on clearCredentials cannot prove the method *registration* is
   * wired. This drives the real server process over stdio, like the permission
   * gate integration test, and calls credential/reset as an MCP request.
   */
  it("resets and returns the scope without a credential value", async () => {
    const { Client } = await import("@modelcontextprotocol/client");
    const { StdioClientTransport } = await import("@modelcontextprotocol/client/stdio");
    const { serverEntryPoint } = await import("./helpers/build-server.js");

    const client = new Client(
      { name: "test", version: "1" },
      { capabilities: {}, versionNegotiation: { mode: "auto" } } as never,
    );
    await client.connect(new StdioClientTransport({
      command: "node",
      args: [serverEntryPoint()],
      env: { PATH: process.env["PATH"] ?? "", HW_REGION_NAME: "cn-north-4" },
    }));

    try {
      const result = await client.request(
        { method: "credential/reset", params: {} },
        z.object({
          scope: z.string(),
          keychain: z.boolean(),
          file: z.boolean(),
          env_active: z.boolean(),
        }),
      );
      expect(result.scope).toBe("default");
      expect(result).not.toHaveProperty("ak");
      expect(result).not.toHaveProperty("sk");
    } finally {
      await client.close();
    }
  });
});
