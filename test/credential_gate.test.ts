import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { scanTfCredentials, assertNoCredentials } from "../src/gates/credential_gate.js";

describe("credential_gate", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "cred-gate-test-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  describe("recursive scanning", () => {
    it("scans root .tf files", async () => {
      await writeFile(join(dir, "main.tf"), `access_key = "HWPABCDEFG"\n`);
      const findings = await scanTfCredentials(dir);
      expect(findings).toHaveLength(1);
      expect(findings[0]!.pattern).toBe("access_key");
      expect(findings[0]!.file).toBe("main.tf");
    });

    it("scans .tf in modules/ subdirectories", async () => {
      await mkdir(join(dir, "modules", "ecs"), { recursive: true });
      await writeFile(join(dir, "modules", "ecs", "main.tf"), `secret_key = "leaked"\n`);
      const findings = await scanTfCredentials(dir);
      expect(findings).toHaveLength(1);
      expect(findings[0]!.file).toBe("modules/ecs/main.tf");
    });

    it("skips .terraform/ directory (provider downloads)", async () => {
      await mkdir(join(dir, ".terraform"), { recursive: true });
      await writeFile(join(dir, ".terraform", "provider.tf"), `access_key = "should-not-scan"\n`);
      const findings = await scanTfCredentials(dir);
      expect(findings).toHaveLength(0);
    });

    it("skips .git/ and other dotdirs", async () => {
      await mkdir(join(dir, ".git"), { recursive: true });
      await writeFile(join(dir, ".git", "config.tf"), `password = "x"\n`);
      const findings = await scanTfCredentials(dir);
      expect(findings).toHaveLength(0);
    });
  });

  describe("pattern matching", () => {
    it("detects access_key, secret_key, security_token, password", async () => {
      await writeFile(join(dir, "a.tf"), `access_key = "AK"\n`);
      await writeFile(join(dir, "b.tf"), `secret_key = "SK"\n`);
      await writeFile(join(dir, "c.tf"), `security_token = "STS"\n`);
      await writeFile(join(dir, "d.tf"), `password = "pw"\n`);
      const findings = await scanTfCredentials(dir);
      const patterns = findings.map((f) => f.pattern).sort();
      expect(patterns).toEqual(["access_key", "password", "secret_key", "security_token"]);
    });

    it("reports correct line numbers", async () => {
      await writeFile(join(dir, "main.tf"), `resource "x" "y" {\n  name = "test"\n  access_key = "AK"\n}\n`);
      const findings = await scanTfCredentials(dir);
      expect(findings[0]!.line).toBe(3);
    });
  });

  describe("var.xxx / data.xxx whitelist", () => {
    it("does not flag access_key = var.access_key", async () => {
      await writeFile(join(dir, "main.tf"), `access_key = var.access_key\n`);
      const findings = await scanTfCredentials(dir);
      expect(findings).toHaveLength(0);
    });

    it("does not flag secret_key = data.huaweicloud_credentials.x.secret_key", async () => {
      await writeFile(join(dir, "main.tf"), `secret_key = data.huaweicloud_credentials.x.secret_key\n`);
      const findings = await scanTfCredentials(dir);
      expect(findings).toHaveLength(0);
    });

    it("flags plaintext access_key even when var.access_key appears elsewhere", async () => {
      await writeFile(join(dir, "main.tf"), `access_key = var.access_key\nsecret_key = "plaintext"\n`);
      const findings = await scanTfCredentials(dir);
      expect(findings).toHaveLength(1);
      expect(findings[0]!.pattern).toBe("secret_key");
    });
  });

  describe("comment skipping", () => {
    it("does not flag # comment lines", async () => {
      await writeFile(join(dir, "main.tf"), `# access_key = "HWPABCDEFG"\n`);
      const findings = await scanTfCredentials(dir);
      expect(findings).toHaveLength(0);
    });

    it("does not flag // comment lines", async () => {
      await writeFile(join(dir, "main.tf"), `// secret_key = "leaked"\n`);
      const findings = await scanTfCredentials(dir);
      expect(findings).toHaveLength(0);
    });

    it("flags plaintext on real lines even when comments present", async () => {
      await writeFile(join(dir, "main.tf"), `# do not hardcode\naccess_key = "AK"\n`);
      const findings = await scanTfCredentials(dir);
      expect(findings).toHaveLength(1);
    });
  });

  describe("assertNoCredentials", () => {
    it("throws when plaintext credentials found", async () => {
      await writeFile(join(dir, "main.tf"), `access_key = "AK"\n`);
      await expect(assertNoCredentials(dir)).rejects.toThrow(/plaintext credential found/);
    });

    it("does not throw when no credentials found", async () => {
      await writeFile(join(dir, "main.tf"), `resource "x" "y" { name = "test" }\n`);
      await expect(assertNoCredentials(dir)).resolves.toBeUndefined();
    });
  });
});
