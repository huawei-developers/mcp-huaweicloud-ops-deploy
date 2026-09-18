/**
 * Build-time script: fetch terraform examples from the huaweicloud provider
 * repo and bundle them into src/data/terraform-examples.zip.
 *
 * Source: GitCode mirror (preferred — GitHub may be unreachable in CN).
 * Fallback: GitHub. Both host huaweicloud/terraform-provider-huaweicloud.
 *
 * Uses sparse checkout to fetch only the examples/ directory (not the whole
 * repo — provider source code is not needed). The result is a zip with the
 * examples/ tree intact (examples/<service>/<scenario>/*.tf).
 *
 * Run: npm run fetch-examples (before npm publish / local build)
 * Output: src/data/terraform-examples.zip
 */

import { execSync } from "node:child_process";
import { rm, mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import AdmZip from "adm-zip";

const REPO_GITCODE = "https://gitcode.com/huaweicloud/terraform-provider-huaweicloud.git";
const REPO_GITHUB = "https://github.com/huaweicloud/terraform-provider-huaweicloud.git";
const CLONE_DIR = join(process.cwd(), ".examples-tmp");
const OUTPUT_ZIP = join(process.cwd(), "src", "data", "terraform-examples.zip");

function cloneExamples(repoUrl: string): void {
  console.log(`Cloning examples from ${repoUrl} ...`);
  execSync(
    `git clone --depth 1 --filter=blob:none --sparse "${repoUrl}" "${CLONE_DIR}"`,
    { stdio: "inherit" },
  );
  execSync("git sparse-checkout set examples", { cwd: CLONE_DIR, stdio: "inherit" });
}

async function packZip(): Promise<void> {
  const examplesDir = join(CLONE_DIR, "examples");
  const entries = await readdir(examplesDir, { withFileTypes: true });
  if (entries.length === 0) {
    throw new Error("examples/ directory is empty — clone may have failed");
  }

  const zip = new AdmZip();
  // Add the entire examples/ tree, preserving relative paths.
  await addDirToZip(zip, examplesDir, "examples");
  await mkdir(join(process.cwd(), "src", "data"), { recursive: true });
  zip.writeZip(OUTPUT_ZIP);
  console.log(`Wrote ${OUTPUT_ZIP}`);
}

async function addDirToZip(zip: AdmZip, dirPath: string, zipPath: string): Promise<void> {
  const { readdir, stat } = await import("node:fs/promises");
  const entries = await readdir(dirPath, { withFileTypes: true });
  for (const e of entries) {
    const full = join(dirPath, e.name);
    const zPath = `${zipPath}/${e.name}`;
    if (e.isDirectory()) {
      await addDirToZip(zip, full, zPath);
    } else if (e.isFile()) {
      const content = await (await import("node:fs/promises")).readFile(full);
      zip.addFile(zPath, content);
    }
  }
}

async function main(): Promise<void> {
  // Try GitCode first, fall back to GitHub.
  for (const url of [REPO_GITCODE, REPO_GITHUB]) {
    try {
      await rm(CLONE_DIR, { recursive: true, force: true });
      cloneExamples(url);
      await packZip();
      await rm(CLONE_DIR, { recursive: true, force: true });
      return;
    } catch (err) {
      console.error(`Failed with ${url}: ${err instanceof Error ? err.message : String(err)}`);
      await rm(CLONE_DIR, { recursive: true, force: true }).catch(() => {});
    }
  }
  console.error("All sources failed. Cannot fetch examples.");
  process.exit(1);
}

main();
