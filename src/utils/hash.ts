/**
 * SHA-256 hash of all .tf files in a deployment dir (§4.3 tf_hash).
 *
 * Deterministic: files sorted by name, content hashed, concatenated.
 *   "sha256:" + SHA256(filename1 + hash1 + filename2 + hash2 + ...)
 *
 * This is the "cost.json.tf_hash" — written by the cost gate after a
 * successful apply, verified on subsequent applies.
 */

import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";

/**
 * Recursively collect .tf file paths (same logic as credential_gate —
 * skips dotdirs, includes modules/). Deterministic hash requires
 * consistent file ordering: relative paths sorted lexicographically.
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

export async function computeTfHash(dir: string): Promise<string> {
  const tfFiles = (await collectTfFiles(dir))
    .map((f) => relative(dir, f))
    .sort();

  const parts: string[] = [];
  for (const name of tfFiles) {
    const content = await readFile(join(dir, name), "utf8");
    const h = createHash("sha256").update(content, "utf8").digest("hex");
    parts.push(`${name}${h}`);
  }
  const concatenated = parts.join("");
  const hash = createHash("sha256").update(concatenated, "utf8").digest("hex");
  return `sha256:${hash}`;
}
