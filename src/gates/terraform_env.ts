/**
 * Stateless terraform execution environment resolver (§6.6).
 *
 * MCP server is stateless — each tool call is independent, server does not
 * remember what terraform_install or terraform_init did. But the terraform
 * subprocess needs to know: binary path, .terraformrc location,
 * TF_PLUGIN_CACHE_DIR, and credential env.
 *
 * Every terraform tool (init/plan/apply/destroy/refresh/state) calls this
 * before spawning. It re-derives from filesystem state — a few stat calls,
 * no cross-call memory.
 *
 * Credential env is injected from the keychain (§5.5) — NEVER passed via
 * tool parameters. The tool-param-controlled env is `extraEnv` — an array
 * of KEY=VALUE strings merged onto the subprocess env (e.g. TF_LOG=DEBUG,
 * TF_LOG_PROVIDER=OFF, TF_CLI_ARGS_plan=-refresh=false).
 */

import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

import { loadCredentials } from "../auth/store.js";

const GLOBAL_BIN_DIR = join(homedir(), ".huaweicloud-ops-deploy", "bin");
const GLOBAL_PLUGIN_DIR = join(homedir(), ".huaweicloud-ops-deploy", "plugins");

export interface ResolvedEnv {
  binary: string;
  env: Record<string, string>;
}

/**
 * Resolve the terraform binary path + env for a deployment.
 * Throws if no binary can be found.
 */
export async function resolveTerraformEnv(
  deployment: string,
  extraEnv: string[] = [],
): Promise<ResolvedEnv> {
  const binary = await resolveBinary(deployment);
  const env: Record<string, string> = {};

  // .terraformrc — provider mirror config
  await resolveTerraformrc(deployment, env);

  // TF_PLUGIN_CACHE_DIR — global provider cache (HOME writable only)
  await resolvePluginCache(env);

  // Credentials from keychain (§5.5). Env var names match the huaweicloud
  // provider's documented names (docs/index.md): HW_ACCESS_KEY, HW_SECRET_KEY,
  // HW_SECURITY_TOKEN, HW_REGION_NAME. Same names auth.ts reads — one set.
  try {
    const creds = await loadCredentials();
    env["HW_ACCESS_KEY"] = creds.ak;
    env["HW_SECRET_KEY"] = creds.sk;
    env["HW_REGION_NAME"] = creds.region;
    if (creds.security_token) {
      env["HW_SECURITY_TOKEN"] = creds.security_token;
    }
  } catch {
    // Not authenticated — terraform will fail with a clear error if it
    // needs creds. We don't block here; some commands (e.g. terraform fmt)
    // don't need creds.
  }

  // Merge user-supplied env vars (KEY=VALUE strings) — e.g. TF_LOG=DEBUG,
  // TF_LOG_PROVIDER=OFF, TF_CLI_ARGS_plan=-refresh=false. These are merged
  // AFTER credentials, so a user-supplied HW_ACCESS_KEY etc. overrides the
  // keychain credentials — this is intentional, allowing per-call account
  // switching. A KEY= (empty value) unsets/empties the var.
  for (const entry of extraEnv) {
    const eq = entry.indexOf("=");
    if (eq >= 0) env[entry.slice(0, eq)] = entry.slice(eq + 1);
  }

  return { binary, env };
}

/** Binary priority: HW_TERRAFORM_PATH env > PATH > global cache > deployment fallback. */
async function resolveBinary(deployment: string): Promise<string> {
  // 1. User-specified via MCP client env.
  const envPath = process.env["HW_TERRAFORM_PATH"];
  if (envPath && (await fileExists(envPath))) {
    return envPath;
  }

  // 2. PATH search.
  const pathBinary = await findInPath("terraform");
  if (pathBinary) {
    return pathBinary;
  }

  // 3. Global cache (~/.huaweicloud-ops-deploy/bin/terraform-*).
  const globalBin = await findGlobalCacheBinary();
  if (globalBin) {
    return globalBin;
  }

  // 4. Deployment fallback (<deployment>/.terraform/bin/terraform).
  const depBin = join(deployment, ".terraform", "bin", "terraform");
  if (await fileExists(depBin)) {
    return depBin;
  }

  throw new Error("terraform not found — call terraform_install first");
}

/** .terraformrc resolution: deployment file > user env > user home > none. */
async function resolveTerraformrc(deployment: string, env: Record<string, string>): Promise<void> {
  const depRc = join(deployment, ".terraformrc");
  if (await fileExists(depRc)) {
    env["TF_CLI_CONFIG_FILE"] = depRc;
    return;
  }

  // User set TF_CLI_CONFIG_FILE in MCP client env — respect it.
  if (process.env["TF_CLI_CONFIG_FILE"]) {
    return;
  }

  // User has ~/.terraformrc — terraform reads it by default, no env needed.
  const homeRc = join(homedir(), ".terraformrc");
  if (await fileExists(homeRc)) {
    return;
  }

  // No config — terraform uses default registry. Server could generate one
  // here, but terraform_init handles that. Other tools just run with defaults.
}

/** TF_PLUGIN_CACHE_DIR — global cache when HOME is writable. */
async function resolvePluginCache(env: Record<string, string>): Promise<void> {
  if (process.env["TF_PLUGIN_CACHE_DIR"]) {
    return; // User set it — respect.
  }
  try {
    await stat(GLOBAL_PLUGIN_DIR);
    env["TF_PLUGIN_CACHE_DIR"] = GLOBAL_PLUGIN_DIR;
  } catch {
    // Global cache dir doesn't exist or HOME not writable — terraform uses
    // per-deployment .terraform/providers/ (its default).
  }
}

/**
 * Find terraform in PATH by running `terraform version`.
 *
 * This is the only reliable way to confirm the binary is actually usable —
 * `which`/`where` only confirm the file exists on PATH, not that it's a
 * working terraform binary (could be a same-named empty file, a corrupt
 * binary, or an architecture mismatch). `terraform version` succeeding
 * means the binary genuinely runs.
 *
 * The extra spawn is negligible: each terraform tool call already spawns a
 * subprocess that runs for seconds-to-minutes (init/plan/apply); a
 * `terraform version` probe takes tens of milliseconds.
 *
 * Using `which` was tried and rejected: Alpine Linux lacks `which` by
 * default, busybox's `which` behaves differently, and Windows `where`
 * emits multiple lines — all for no real benefit.
 */
async function findInPath(_name: string): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn("terraform", ["version"], { stdio: ["ignore", "pipe", "pipe"] });
    child.on("error", () => resolve(null));
    child.on("close", (code) => resolve(code === 0 ? "terraform" : null));
  });
}

/** Find a cached binary in ~/.huaweicloud-ops-deploy/bin/ (terraform-<ver>). */
async function findGlobalCacheBinary(): Promise<string | null> {
  try {
    const { readdir } = await import("node:fs/promises");
    const entries = await readdir(GLOBAL_BIN_DIR);
    // Prefer versioned (terraform-1.9.5), fallback to unversioned (terraform).
    const versioned = entries.filter((e) => e.startsWith("terraform-"));
    if (versioned.length > 0) {
      // Sort descending — latest version first.
      versioned.sort().reverse();
      const path = join(GLOBAL_BIN_DIR, versioned[0]!);
      if (await fileExists(path)) return path;
    }
    const plain = join(GLOBAL_BIN_DIR, "terraform");
    if (await fileExists(plain)) return plain;
    return null;
  } catch {
    return null;
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    const info = await stat(path);
    return info.isFile();
  } catch {
    return false;
  }
}
