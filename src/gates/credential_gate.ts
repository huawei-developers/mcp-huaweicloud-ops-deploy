/**
 * credential_gate.ts — plaintext credential scanner (§6.2).
 *
 * Deterministic grep for access_key/secret_key/security_token/password
 * assignments in .tf files. Catches the most severe leak: credentials
 * hardcoded into .tf. Whitelists var.xxx / data.xxx references (those are
 * not plaintext values, though instructions still say don't define cred
 * variables — the gate only catches the plaintext case).
 *
 * Mounted at terraform_init (early exposure) and terraform_apply (§6.3 门 4).
 */

import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";

const PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: "access_key", re: /access_key\s*=\s*"[^"]+"/ },
  { name: "secret_key", re: /secret_key\s*=\s*"[^"]+"/ },
  { name: "security_token", re: /security_token\s*=\s*"[^"]+"/ },
  { name: "password", re: /password\s*=\s*"[^"]+"/ },
];

export interface CredentialFinding {
  file: string;
  line: number;
  pattern: string;
}

/**
 * Recursively collect all .tf file paths under dir. Skips dotdirs/dotfiles
 * (.terraform/, .git/, etc. — none contain user-authored .tf). Terraform
 * modules (modules/xxx/main.tf) ARE included — they compile into the plan,
 * so credentials there are just as much a leak risk as root .tf.
 */
async function collectTfFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const e of entries) {
    if (e.name.startsWith(".")) continue; // skip .terraform/, .git/, etc.
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      files.push(...(await collectTfFiles(full)));
    } else if (e.isFile() && e.name.endsWith(".tf")) {
      files.push(full);
    }
  }
  return files;
}

/** Scan all .tf files (recursively, including modules/) for plaintext credentials. */
export async function scanTfCredentials(dir: string): Promise<CredentialFinding[]> {
  const tfFiles = await collectTfFiles(dir);
  const findings: CredentialFinding[] = [];
  for (const path of tfFiles) {
    const relPath = relative(dir, path);
    const content = await readFile(path, "utf8");
    const lines = content.split("\n");
    for (const [lineNum, line] of lines.entries()) {
      const trimmed = line.trim();
      // Skip comments (# or //) — HCL comment lines, not real assignments.
      if (trimmed.startsWith("#") || trimmed.startsWith("//")) continue;
      // Skip var.xxx / data.xxx references — not plaintext.
      if (/=\s*(var\.|data\.)/.test(line)) continue;
      for (const { name, re } of PATTERNS) {
        if (re.test(line)) {
          findings.push({ file: relPath, line: lineNum + 1, pattern: name });
        }
      }
    }
  }
  return findings;
}

/** Throw if any plaintext credential is found. */
export async function assertNoCredentials(dir: string): Promise<void> {
  const findings = await scanTfCredentials(dir);
  if (findings.length > 0) {
    const first = findings[0]!;
    throw new Error(
      `plaintext credential found in ${first.file}: line ${first.line} — ` +
        "remove access_key/secret_key/security_token assignments (see §6.2)",
    );
  }
}
