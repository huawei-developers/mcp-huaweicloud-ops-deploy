import type { CallToolResult, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

import { fail, guard, ok, type ToolCtx } from "./errors.js";
import { deploymentParam } from "./index.js";
import { assertNoCredentials } from "../gates/credential_gate.js";
import { extractArchive } from "../utils/tar.js";
import { assertNetworking } from "../gates/networking_gate.js";
import { runCostGate, fillTfHash } from "../gates/cost_gate.js";
import { resolveTerraformEnv } from "../gates/terraform_env.js";
import { writeProviderMirrorConfig, HUAWEICLOUD_PROVIDER_MIRRORS } from "../gates/mirror.js";
import { createTask, updateTask, type Task } from "../tasks/manager.js";
import { extractSecurityGroups, type SecgroupRuleView } from "../extract/security_groups.js";
import { updateSnapshot, stateRecordedResourceCount, backfillAccount } from "../deployment/state.js";
import { loadAccount } from "../auth/store.js";

/** Shared terraform runner: resolve env, then spawn. */
export interface TerraformResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** True if stdout was truncated at MAX_OUTPUT_BYTES (output incomplete). */
  stdoutTruncated?: boolean;
  /** True if stderr was truncated at MAX_OUTPUT_BYTES. */
  stderrTruncated?: boolean;
}

/** Max stdout/stderr size per subprocess — 50MB. Prevents OOM on huge plans. */
const MAX_OUTPUT_BYTES = 50 * 1024 * 1024;

/** Default timeout for terraform commands (30 min — apply can be long). */
const TERRAFORM_TIMEOUT_MS = 30 * 60 * 1000;

export async function runTerraform(cwd: string, args: string[], extraEnv: string[] = []): Promise<TerraformResult> {
  const { binary, env } = await resolveTerraformEnv(cwd, extraEnv);
  if (env["HW_ACCESS_KEY"]) {
    const account = await loadAccount().catch(() => null);
    if (account) {
      await backfillAccount(cwd, { name: account.account_name, account_id: account.account_id }).catch(() => {});
    }
  }
  return new Promise((resolve) => {
    const child = spawn(binary, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let stdoutTruncated = false;
    let stderrTruncated = false;
    child.stdout.on("data", (d) => {
      if (!stdoutTruncated && stdout.length + d.length > MAX_OUTPUT_BYTES) {
        stdout += d.toString().slice(0, MAX_OUTPUT_BYTES - stdout.length);
        stdoutTruncated = true;
        child.kill("SIGTERM");
      } else if (!stdoutTruncated) {
        stdout += d.toString();
      }
    });
    child.stderr.on("data", (d) => {
      if (!stderrTruncated && stderr.length + d.length > MAX_OUTPUT_BYTES) {
        stderr += d.toString().slice(0, MAX_OUTPUT_BYTES - stderr.length);
        stderrTruncated = true;
      } else if (!stderrTruncated) {
        stderr += d.toString();
      }
    });
    // Timeout — kill if terraform hangs (network stall, interactive prompt).
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      // Give it 5s to clean up, then force kill.
      setTimeout(() => child.kill("SIGKILL"), 5000);
    }, TERRAFORM_TIMEOUT_MS);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code ?? 0, stdout, stderr, stdoutTruncated, stderrTruncated });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ exitCode: -1, stdout, stderr: err.message, stdoutTruncated, stderrTruncated });
    });
  });
}

/** Register all 9 terraform tools. */
export function registerTerraformTools(mcp: McpServer): void {
  // Capture the low-level Server for client-capability probing at handler
  // time. getClientCapabilities() is the SDK's public API for reading the
  // initialize-declared client capabilities — not deprecated (the Server
  // class itself carries a @deprecated hint pointing to McpServer, but the
  // method is functional and is the only way to probe capabilities in
  // legacy-era connections, which is what we serve).
  lowLevelServer = mcp.server;
  registerInstall(mcp);
  registerInit(mcp);
  registerPlan(mcp);
  registerApply(mcp);
  registerDestroy(mcp);
  registerRefresh(mcp);
  registerState(mcp);
  registerImport(mcp);
}

/** Captured at registration; used to probe client tasks capability. */
let lowLevelServer: McpServer["server"] | null = null;

/**
 * Check whether the connected client declared tasks support.
 *
 * Reads `Server.getClientCapabilities()` — the initialize-declared client
 * capabilities. In legacy era (what we serve today) this is the only way to
 * detect tasks support; per-request envelopes are a 2026-era mechanism that
 * legacy clients don't send.
 *
 * Checks both the core `tasks` field (legacy/Inspector) and the
 * `io.modelcontextprotocol/tasks` extension (v2 spec) — either means the
 * client can poll tasks/get.
 *
 * If false → synchronous execution with progress notifications (fallback).
 */
function clientHasTasksCap(): boolean {
  const caps = lowLevelServer?.getClientCapabilities();
  if (!caps) return false;
  if (caps.tasks) return true;
  const ext = caps.extensions as Record<string, unknown> | undefined;
  return Boolean(ext?.["io.modelcontextprotocol/tasks"]);
}

const envParam = z.array(z.string()).optional().describe("Extra env vars for the terraform subprocess, each KEY=VALUE. e.g. [\"TF_LOG=DEBUG\", \"TF_LOG_PROVIDER=OFF\", \"TF_CLI_ARGS_plan=-refresh=false\"]");

function registerInstall(mcp: McpServer): void {
  mcp.registerTool(
    "terraform_install",
    {
      title: "安装 terraform",
      description:
        "Ensure a terraform binary is available. Only installs the binary — provider " +
        "plugins are pulled by terraform_init. Priority: terraform_path param > PATH > " +
        "global cache (~/.huaweicloud-ops-deploy/bin/) > download from binary_mirrors. " +
        "Download falls back to <deployment>/.terraform/bin/ when HOME is not writable.",
      inputSchema: z.object({
        deployment: deploymentParam.describe("Used only as download fallback when HOME is not writable."),
        terraform_path: z.string().optional().describe("Explicit path to a terraform binary."),
        binary_mirrors: z.array(z.string()).optional().describe("Binary download mirror URLs, tried in order."),
        env: envParam,
      }),
    },
    guard(async (args, ctx) => handleInstall(args.deployment, args.terraform_path, args.binary_mirrors, args.env ?? [], ctx)),
  );
}

async function handleInstall(
  deployment: string,
  terraformPath?: string,
  binaryMirrors?: string[],
  extraEnv: string[] = [],
  ctx?: ToolCtx,
) {
  // 1. Explicit path.
  if (terraformPath) {
    const { stat } = await import("node:fs/promises");
    try {
      const info = await stat(terraformPath);
      if (!info.isFile()) return fail(`terraform_path is not a file: ${terraformPath}`);
    } catch {
      return fail(`terraform_path not found: ${terraformPath}`);
    }
    return ok(JSON.stringify({ terraform: "(user-specified)", path: terraformPath, source: "parameter", cached: true }));
  }

  // 2. PATH or global cache — try resolveTerraformEnv.
  try {
    const { binary } = await resolveTerraformEnv(deployment, extraEnv);
    const ver = await getTerraformVersion(binary);
    return ok(JSON.stringify({ terraform: ver, path: binary, source: "path-or-cache", cached: true }));
  } catch {
    // Not found — proceed to download.
  }

  // 3. Download — long operation, run as task.
  const mirrors = binaryMirrors ?? DEFAULT_BINARY_MIRRORS;
  const { version, arch, platform } = detectPlatform();
  const destDir = await resolveDownloadDir(deployment);
  const binPath = join(destDir, `terraform${version ? "-" + version : ""}`);

  return launchTaskResult(
    ctx, deployment, "terraform_install", "downloading terraform binary...",
    async () => {
      const failures: Array<{ mirror: string; reason: string; kind: DownloadErrorKind }> = [];
      for (const mirror of mirrors) {
        try {
          await downloadAndExtract(mirror, version, platform, arch, destDir);
          const ver = await getTerraformVersion(binPath);
          return { exit_code: 0, outputs: { terraform: ver, path: binPath, source: "downloaded", cached: false } };
        } catch (err) {
          const kind = (err as DownloadError).kind ?? "network";
          failures.push({ mirror, reason: err instanceof Error ? err.message : String(err), kind });
        }
      }

      const detail = failures.map((f) => `  - ${f.mirror}: ${f.reason}`).join("\n");
      const kinds = new Set(failures.map((f) => f.kind));
      const actions: string[] = [];
      if (kinds.has("http_4xx")) {
        actions.push(
          `the mirror does not host terraform ${version} for ${platform}_${arch} (HTTP 4xx). ` +
          `Retrying won't help — re-invoke terraform_install with a different version, or pass ` +
          `binary_mirrors pointing at a mirror that has it.`,
        );
      }
      if (kinds.has("network")) {
        actions.push(
          `the mirror is unreachable (DNS/connection/TLS). A transient blip may clear on retry — ` +
          `re-invoke terraform_install once; if it fails again, obtain a terraform binary yourself ` +
          `(via shell: download + unzip, or a package manager) and re-invoke with terraform_path.`,
        );
      }
      if (kinds.has("http_5xx")) {
        actions.push(
          `the mirror returned a server error (HTTP 5xx) — temporarily broken. Retry terraform_install ` +
          `after a short wait, or pass a different binary_mirrors.`,
        );
      }
      if (kinds.has("extraction")) {
        actions.push(
          `the downloaded zip is corrupt or unreadable. Retry terraform_install once; if it fails again, ` +
          `the mirror may be serving a bad artifact — try a different binary_mirrors.`,
        );
      }
      actions.push(
        `If mirrors keep failing, obtain a terraform binary yourself (e.g. via shell: ` +
        `download from https://releases.hashicorp.com/terraform/<ver>/terraform_<ver>_<os>_<arch>.zip ` +
        `and unzip it, or use a package manager), then re-invoke terraform_install with ` +
        `terraform_path pointing at the executable.`,
      );
      return {
        exit_code: 1,
        outputs: {
          error: `terraform not found and download failed from all ${mirrors.length} mirror(s):\n${detail}\nNext actions:\n${actions.map((a) => `  - ${a}`).join("\n")}`,
        },
      };
    },
  );
}

function registerInit(mcp: McpServer): void {
  mcp.registerTool(
    "terraform_init",
    {
      title: "terraform init",
      description:
        "Run `terraform init`. Generates <deployment>/.terraformrc with provider mirror " +
        "config (if not user-provided), sets TF_PLUGIN_CACHE_DIR, pulls provider plugins. " +
        "Credential env injected from keychain.",
      inputSchema: z.object({
        deployment: deploymentParam,
        provider_mirrors: z.array(z.string()).optional().describe("Provider mirror URLs/paths."),
        env: envParam,
      }),
    },
    guard(async (args, ctx) => handleInit(args.deployment, args.provider_mirrors, args.env ?? [], ctx)),
  );
}

async function handleInit(deployment: string, providerMirrors?: string[], extraEnv: string[] = [], ctx?: ToolCtx) {
  try {
    await assertNoCredentials(deployment);
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }

  const mirrors = providerMirrors ?? HUAWEICLOUD_PROVIDER_MIRRORS;
  await writeProviderMirrorConfig(deployment, mirrors);

  return launchTaskResult(
    ctx, deployment, "terraform_init", "terraform init in progress...",
    async () => {
      const result = await runTerraform(deployment, ["init"], extraEnv);
      if (result.exitCode !== 0) {
        return { exit_code: result.exitCode, outputs: { stdout: result.stdout, stderr: result.stderr } };
      }
      return { exit_code: 0, outputs: { stdout: result.stdout, stderr: result.stderr } };
    },
  );
}

function registerPlan(mcp: McpServer): void {
  mcp.registerTool(
    "terraform_plan",
    {
      title: "terraform plan",
      description:
        "Run `terraform plan`. Returns a STRUCTURED plan (terraform show -json) " +
        "to parse and reorganize into human-readable form for the user.",
      inputSchema: z.object({ deployment: deploymentParam, env: envParam }),
    },
    guard(async (args, ctx) => handlePlan(args.deployment, args.env ?? [], ctx)),
  );
}

async function handlePlan(deployment: string, extraEnv: string[] = [], ctx?: ToolCtx) {
  return launchTaskResult(
    ctx, deployment, "terraform_plan", "terraform plan in progress...",
    async () => {
      const result = await runTerraform(deployment, ["plan", "-out=plan.tfplan", "-json"], extraEnv);
      if (result.exitCode !== 0) {
        // terraform plan -json emits diagnostics as JSON lines on stdout
        // ({"type":"diagnostic","level":"error","summary":"..."}), not stderr.
        // Include BOTH so the LLM can see the actual error — dropping stdout
        // here was swallowing the .tf validation messages.
        return { exit_code: result.exitCode, outputs: { stdout: result.stdout, stderr: result.stderr } };
      }
      // Get structured plan via show -json.
      let planJson: unknown = null;
      let sgRules: SecgroupRuleView[] = [];
      let planTruncated = false;
      try {
        const showResult = await runTerraform(deployment, ["show", "-json", "plan.tfplan"], extraEnv);
        if (showResult.exitCode === 0) {
          if (showResult.stdoutTruncated) planTruncated = true;
          planJson = JSON.parse(showResult.stdout);
          sgRules = extractSecurityGroups(planJson as never);
        }
      } catch { /* best-effort — plan_json stays null */ }
      // Summary: derive from plan_json.resource_changes (authoritative) when
      // available. parsePlanSummary (stdout "summary" line) is a fallback — but
      // note terraform 1.9+ emits type:"change_summary" not type:"summary" in
      // -out mode, so the stdout parse often returns 0. The plan_json path is
      // version-independent: resource_changes[].change.actions is stable.
      const summary = planJson
        ? summaryFromPlanJson(planJson)
        : parsePlanSummary(result.stdout);
      return {
        exit_code: 0,
        outputs: {
          plan_json: planJson,
          summary: { ...summary, security_group_rules: sgRules },
          ...(planTruncated ? { warning: "plan output exceeded size limit and was truncated — plan_json may be incomplete or null" } : {}),
        },
      };
    },
  );
}

function registerApply(mcp: McpServer): void {
  mcp.registerTool(
    "terraform_apply",
    {
      title: "terraform apply",
      description:
        "Run `terraform apply`. Enforces four safety gates: networking.json exists, " +
        "cost.json exists, tf_hash state machine, no plaintext credentials.",
      inputSchema: z.object({ deployment: deploymentParam, env: envParam }),
    },
    guard(async (args, ctx) => handleApply(args.deployment, args.env ?? [], ctx)),
  );
}

async function handleApply(deployment: string, extraEnv: string[] = [], ctx?: ToolCtx) {
  // Safety gates — synchronous fast-fail before launching the task.
  try {
    await assertNetworking(deployment);
    await runCostGate(deployment);
    await assertNoCredentials(deployment);
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
  return launchTaskResult(
    ctx, deployment, "terraform_apply", "terraform apply in progress...",
    async () => {
      const result = await runTerraform(deployment, ["apply", "-auto-approve"], extraEnv);
      if (result.exitCode !== 0) {
        return { exit_code: result.exitCode, outputs: { stdout: result.stdout, stderr: result.stderr } };
      }
      try { await fillTfHash(deployment); } catch { /* non-fatal */ }
      await updateSnapshot(deployment, { applied: true, last_operation: "terraform_apply" });
      return { exit_code: 0, outputs: { stdout: result.stdout, stderr: result.stderr } };
    },
  );
}

function registerDestroy(mcp: McpServer): void {
  mcp.registerTool(
    "terraform_destroy",
    {
      title: "terraform destroy",
      description:
        "Run `terraform destroy`. Permanently deletes cloud resources managed by this " +
        "deployment — irreversible. MUST confirm with the user before calling. " +
        "Safety gate: refuses if tfstate is empty (nothing to destroy) or if .tf files contain " +
        "plaintext credentials (same scan as init/apply). " +
        "By default destroys ALL resources in the deployment. Pass `target` to destroy only " +
        "specific resources by address — use this to spare imported (reuse) resources: " +
        "destroy only the newly-created resources, leaving imported ones in state. " +
        "Call terraform_state first to list resource addresses. " +
        "A future enhancement will return a structured plan -destroy preview for the user to review before the actual destroy.",
      inputSchema: z.object({
        deployment: deploymentParam,
        target: z.array(z.string()).optional().describe(
          "Resource addresses to destroy selectively. e.g. " +
          "[\"huaweicloud_vpc.main\", \"huaweicloud_vpc_subnet.sub1\"]. " +
          "Omit to destroy ALL resources (default). " +
          "Use terraform_state to list addresses. " +
          "Use this to spare imported resources: destroy only newly-created resources, leaving imported ones in state."
        ),
        env: envParam,
      }),
    },
    guard(async (args, ctx) => {
      // Gate 1: tfstate must be non-empty — there must be resources to destroy.
      // Destroying an empty deployment is a no-op that masks bugs (wrong dir,
      // already-destroyed state). The check is on terraform.tfstate existence
      // + resource count, not on the live cloud (that'd need a refresh).
      const recordedCount = await stateRecordedResourceCount(args.deployment);
      if (recordedCount === 0) {
        return fail("no resources recorded in tfstate — nothing to destroy (already destroyed or never applied)");
      }
      try {
        await assertNoCredentials(args.deployment);
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
      return launchTaskResult(
        ctx, args.deployment, "terraform_destroy", "terraform destroy in progress...",
        async () => {
          const tfArgs = ["destroy", "-auto-approve"];
          if (args.target && args.target.length > 0) {
            for (const t of args.target) {
              tfArgs.push(`-target=${t}`);
            }
          }
          const result = await runTerraform(args.deployment, tfArgs, args.env ?? []);
          if (result.exitCode !== 0) {
            return { exit_code: result.exitCode, outputs: { stdout: result.stdout, stderr: result.stderr } };
          }
          await updateSnapshot(args.deployment, { destroyed: true, last_operation: "terraform_destroy" });
          return {
            exit_code: 0,
            outputs: {
              stdout: result.stdout,
              stderr: result.stderr,
              resources_destroyed: args.target ? args.target.length : recordedCount,
              ...(args.target ? { targeted: args.target } : {}),
            },
          };
        },
      );
    }),
  );
}

function registerRefresh(mcp: McpServer): void {
  mcp.registerTool(
    "terraform_refresh",
    {
      title: "terraform refresh",
      description: "Run `terraform apply -refresh-only`. Updates tfstate to reflect real cloud state.",
      inputSchema: z.object({ deployment: deploymentParam, env: envParam }),
    },
    guard(async (args, ctx) => {
      return launchTaskResult(
        ctx, args.deployment, "terraform_refresh", "terraform refresh in progress...",
        async () => {
          const result = await runTerraform(args.deployment, ["apply", "-refresh-only", "-auto-approve"], args.env ?? []);
          if (result.exitCode !== 0) {
            return { exit_code: result.exitCode, outputs: { stdout: result.stdout, stderr: result.stderr } };
          }
          return { exit_code: 0, outputs: { stdout: result.stdout, stderr: result.stderr } };
        },
      );
    }),
  );
}

function registerState(mcp: McpServer): void {
  mcp.registerTool(
    "terraform_state",
    {
      title: "读取 tfstate",
      description:
        "Read terraform state via `terraform show -json`. Returns structured " +
        "state. Uses terraform's stable show -json interface (not direct " +
        "tfstate parse).",
      inputSchema: z.object({ deployment: deploymentParam, env: envParam }),
    },
    guard(async (args) => {
      const result = await runTerraform(args.deployment, ["show", "-json"], args.env ?? []);
      if (result.exitCode !== 0) return fail(`terraform state read failed: exit ${result.exitCode}: ${result.stderr}`);
      if (result.stdoutTruncated) {
        return fail("terraform state output exceeded size limit and was truncated — state too large to parse");
      }
      try {
        const stateJson = JSON.parse(result.stdout);
        let sgRules: SecgroupRuleView[] = [];
        try { sgRules = extractSecurityGroups(stateJson as never); } catch { /* best-effort */ }
        return ok(JSON.stringify({ state_json: stateJson, security_group_rules: sgRules }));
      } catch (err) {
        return fail(`failed to parse state: ${err instanceof Error ? err.message : String(err)}`);
      }
    }),
  );
}

function registerImport(mcp: McpServer): void {
  mcp.registerTool(
    "terraform_import",
    {
      title: "terraform import",
      description:
        "Run `terraform import` to bring an existing cloud resource into tfstate " +
        "without creating it. Use after list_existing_resources to reuse an " +
        "existing resource: write the resource block in .tf (with the same " +
        "address), then import to populate its state. The resource address " +
        "and ID format depend on the provider type — check provider docs or " +
        "apiexplorer for the import syntax (e.g. " +
        "huaweicloud_compute_instance.myvm <instance-id>).",
      inputSchema: z.object({
        deployment: deploymentParam,
        address: z.string().min(1).describe("Terraform resource address, e.g. huaweicloud_compute_instance.myvm"),
        id: z.string().min(1).describe("Cloud resource ID to import (provider-specific format)"),
        env: envParam,
      }),
    },
    guard(async (args) => handleImport(args.deployment, args.address, args.id, args.env ?? [])),
  );
}

async function handleImport(deployment: string, address: string, id: string, extraEnv: string[] = []) {
  try {
    await assertNoCredentials(deployment);
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
  const result = await runTerraform(deployment, ["import", address, id], extraEnv);
  if (result.exitCode !== 0) {
    return fail(JSON.stringify({ stdout: result.stdout, stderr: result.stderr }));
  }
  return ok(JSON.stringify({ address, id, imported: true, stdout: result.stdout, stderr: result.stderr }));
}

/** Get terraform version string via `terraform version`. */
async function getTerraformVersion(binary: string): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn(binary, ["version"], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => { out += d.toString(); });
    child.on("close", () => {
      const m = out.match(/Terraform v(\S+)/);
      resolve(m ? m[1]! : "unknown");
    });
    child.on("error", () => resolve("unknown"));
  });
}

/**
 * Default terraform version to download when the user doesn't pin one.
 *
 * Pinned rather than "latest" to keep installs reproducible and avoid a
 * network round-trip to probe the latest version. Bump this when a newer
 * version is vetted. Verified available:
 *   https://releases.hashicorp.com/terraform/1.9.5/terraform_1.9.5_linux_amd64.zip
 */
const DEFAULT_TERRAFORM_VERSION = "1.9.5";

/**
 * Default binary download mirrors, tried in order.
 *
 * HuaweiCloud does NOT mirror the terraform binary (verified:
 * mirrors.huaweicloud.com/terraform/ hosts only the provider registry;
 * .../hashicorp/terraform/ returns HTML, not zip). The only source is
 * HashiCorp's official releases. A continental-CDN mirror would help
 * download speed in CN, but none was found — the user can pass
 * binary_mirrors to override with a known-good mirror.
 */
const DEFAULT_BINARY_MIRRORS = ["https://releases.hashicorp.com/terraform/"];

/** Detect platform for download URL construction. */
function detectPlatform(): { version: string; arch: string; platform: string } {
  const platform = process.platform === "win32" ? "windows" : process.platform === "darwin" ? "darwin" : "linux";
  const arch = process.arch === "arm64" ? "arm64" : "amd64";
  return { version: DEFAULT_TERRAFORM_VERSION, arch, platform };
}

/** Resolve download dir: global cache preferred, deployment fallback. */
async function resolveDownloadDir(deployment: string): Promise<string> {
  const globalDir = join(homedir(), ".huaweicloud-ops-deploy", "bin");
  try {
    await mkdir(globalDir, { recursive: true });
    // Test writability by creating a temp file.
    const testFile = join(globalDir, ".write-test");
    await writeFile(testFile, "");
    const { unlink } = await import("node:fs/promises");
    await unlink(testFile);
    return globalDir;
  } catch {
    // HOME not writable — fallback to deployment.
    const depDir = join(deployment, ".terraform", "bin");
    await mkdir(depDir, { recursive: true });
    return depDir;
  }
}

/**
 * Download + extract terraform binary from a mirror.
 *
 * URL pattern: <mirror>/<version>/terraform_<version>_<os>_<arch>.zip
 *   e.g. https://releases.hashicorp.com/terraform/1.9.5/terraform_1.9.5_linux_amd64.zip
 *
 * Downloads to a temp file, extracts via extractArchive (adm-zip), then
 * renames the extracted `terraform` binary to a versioned name and makes it
 * executable. Non-windows only chmod — Windows doesn't need the exec bit.
 *
 * @throws DownloadError (with `kind`) on any failure. The kind lets handleInstall
 *         give the LLM a concrete next action instead of a generic "failed".
 */
type DownloadErrorKind = "network" | "http_4xx" | "http_5xx" | "extraction";
interface DownloadError extends Error {
  kind: DownloadErrorKind;
}
function downloadError(kind: DownloadErrorKind, message: string): DownloadError {
  const e = new Error(message) as DownloadError;
  e.kind = kind;
  return e;
}

async function downloadAndExtract(
  mirror: string,
  version: string,
  platform: string,
  arch: string,
  destDir: string,
): Promise<void> {
  const base = mirror.endsWith("/") ? mirror : mirror + "/";
  const url = `${base}${version}/terraform_${version}_${platform}_${arch}.zip`;

  // fetch throws TypeError on network failures (DNS, refused, timeout, TLS).
  // The bare "fetch failed" is useless to the LLM — unwrap the cause to
  // surface the actual reason (e.g. ENOTFOUND, ECONNREFUSED, certificate error).
  let resp: Response;
  try {
    resp = await fetch(url, { signal: AbortSignal.timeout(300000) }); // 5 min for binary download
  } catch (err) {
    const cause = err instanceof Error && err.cause instanceof Error ? err.cause as NodeJS.ErrnoException : null;
    const detail = cause ? `${cause.code ?? cause.name}: ${cause.message}` : (err instanceof Error ? err.message : String(err));
    throw downloadError("network", `network error fetching ${url}: ${detail}`);
  }
  if (!resp.ok) {
    const kind = resp.status >= 500 ? "http_5xx" : "http_4xx";
    throw downloadError(kind, `HTTP ${resp.status} ${resp.statusText} fetching ${url}`);
  }
  const buf = Buffer.from(await resp.arrayBuffer());

  // Write to a temp file in destDir, extract, clean up.
  const { writeFile: writeFileFs, unlink, rename } = await import("node:fs/promises");
  const tmpZip = join(destDir, `.terraform-${version}-${Date.now()}.zip`);
  await writeFileFs(tmpZip, buf);
  try {
    await extractArchive(tmpZip, destDir);
  } catch (err) {
    throw downloadError("extraction", `zip extraction failed for ${url}: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    await unlink(tmpZip).catch(() => {});
  }

  // The zip extracts a single `terraform` binary. Rename to a versioned name
  // so resolveTerraformEnv's global-cache search (terraform-<ver>) finds it.
  // If the versioned name already exists (e.g. a prior partial download), we
  // do NOT swallow the rename error — a swallowed rename leaves the binary at
  // the unversioned path while chmod targets the versioned one, producing a
  // non-executable binary that getTerraformVersion can't run.
  const extractedPath = join(destDir, "terraform");
  const versionedPath = join(destDir, `terraform-${version}`);
  await rename(extractedPath, versionedPath);

  // adm-zip's extractAllTo does not preserve unix exec bits — the extracted
  // binary is mode 0666 and won't run. chmod it executable (non-windows only;
  // Windows has no exec bit).
  if (platform !== "windows") {
    const { chmod } = await import("node:fs/promises");
    await chmod(versionedPath, 0o755);
  }
}

/** Parse `terraform plan -json` output for create/change/destroy counts. */
function parsePlanSummary(stdout: string): { create: number; change: number; destroy: number } {
  const summary = { create: 0, change: 0, destroy: 0 };
  for (const line of stdout.split("\n")) {
    try {
      const obj = JSON.parse(line) as { type?: string; changes?: { add?: number; change?: number; destroy?: number } };
      if (obj.type === "summary" && obj.changes) {
        summary.create = obj.changes.add ?? 0;
        summary.change = obj.changes.change ?? 0;
        summary.destroy = obj.changes.destroy ?? 0;
        break;
      }
    } catch { /* not a JSON line */ }
  }
  return summary;
}

/**
 * Derive create/change/destroy counts from `terraform show -json <plan>`
 * resource_changes — the authoritative, version-independent source.
 *
 * terraform 1.9+ changed the `plan -json` stdout summary line to
 * type:"change_summary" (from type:"summary"), so parsePlanSummary returns 0.
 * The show -json output's resource_changes[].change.actions is stable across
 * versions: actions is an array like ["create"], ["update"], ["delete"],
 * ["no-op"], or composite like ["create","delete"] (replace). We take the
 * first action as the primary — same mapping convention as terraform's own
 * tfjson (see iac-server's planFromJSON actionFromTFJSON).
 */
export function summaryFromPlanJson(planJson: unknown): { create: number; change: number; destroy: number } {
  const summary = { create: 0, change: 0, destroy: 0 };
  const rc = (planJson as { resource_changes?: Array<{ change?: { actions?: string[] } }> })?.resource_changes;
  if (!rc) return summary;
  for (const r of rc) {
    const actions = r.change?.actions ?? [];
    if (actions.length === 0) continue;
    // Take the first action as primary (matches terraform tfjson convention).
    const primary = actions[0]!;
    if (primary === "create") summary.create++;
    else if (primary === "update") summary.change++;
    else if (primary === "delete") summary.destroy++;
    // "no-op" and others (e.g. "read") don't count.
  }
  return summary;
}

/**
 * Run a long-running terraform operation and return the tool-call result.
 *
 * Two paths, chosen by client capability:
 *
 * - **Client supports tasks**: launch as a background task, return a task
 *   handle (standard CallToolResult with content + structuredContent). The
 *   client polls tasks/get.
 *
 * - **Client lacks tasks capability**: run the work synchronously, sending
 *   periodic `notifications/progress` to keep the client's callTool alive
 *   (clients like opencode use `resetTimeoutOnProgress: true`). The handler
 *   blocks until terraform finishes, then returns the final result directly.
 *   This is the MCP-standard progress mechanism — no tasks capability needed.
 *
 * Safety gates MUST run BEFORE calling this (synchronous fast-fail).
 */
async function launchTaskResult(
  ctx: ToolCtx | undefined,
  deployment: string,
  operation: string,
  statusMessage: string,
  work: () => Promise<{ exit_code: number; outputs?: Record<string, unknown> }>,
): Promise<CallToolResult> {
  if (clientHasTasksCap()) {
    const task = await launchTerraformTask(deployment, operation, statusMessage, work);
    return taskToResult(task);
  }
  // Fallback: synchronous run with progress notifications.
  return await runWithProgress(ctx, operation, statusMessage, work);
}

/** Progress notification interval (fallback path). */
const PROGRESS_INTERVAL_MS = 5000;

/**
 * Run a long operation synchronously, sending periodic progress notifications
 * to keep the client's callTool alive.
 *
 * Used when the client lacks tasks capability. The MCP spec's progress
 * mechanism: the client sends a `progressToken` in `_meta`, the server sends
 * `notifications/progress` with that token while working, and clients with
 * `resetTimeoutOnProgress` keep the request alive. The handler blocks until
 * work() resolves, then returns the final result as a standard CallToolResult.
 *
 * If no progressToken is present (client didn't send one), we still run
 * synchronously — the client's callTool timeout applies, but most clients
 * default to a generous timeout for tool calls.
 */
async function runWithProgress(
  ctx: ToolCtx | undefined,
  operation: string,
  statusMessage: string,
  work: () => Promise<{ exit_code: number; outputs?: Record<string, unknown> }>,
): Promise<CallToolResult> {
  const progressToken = ctx?.mcpReq?._meta?.progressToken;
  const notify = ctx?.mcpReq?.notify;

  let ticks = 0;
  const timer = progressToken !== undefined && notify
    ? setInterval(() => {
        ticks++;
        notify({
          method: "notifications/progress",
          params: { progressToken, progress: ticks, message: `${operation}: ${statusMessage} (${ticks * PROGRESS_INTERVAL_MS / 1000}s)` },
        }).catch(() => { /* best-effort — don't crash on notify failure */ });
      }, PROGRESS_INTERVAL_MS)
    : undefined;

  try {
    const result = await work();
    if (result.exit_code === 0) {
      return ok(JSON.stringify(result.outputs ?? {}));
    }
    return fail(JSON.stringify(result.outputs ?? { error: `exit ${result.exit_code}` }));
  } finally {
    if (timer) clearInterval(timer);
  }
}

/**
 * Launch a long-running terraform op as a task (§8.2).
 *
 * The operation is an async function that does the actual work (may call
 * runTerraform multiple times — e.g. plan + show -json). The task is created
 * immediately and the operation runs in the background; the caller gets a
 * task handle to poll via tasks/get or cancel via tasks/cancel.
 *
 * Safety gates MUST run BEFORE calling this (synchronous fast-fail) — once
 * the task is launched, the terraform subprocess is running.
 */
export async function launchTerraformTask(
  deployment: string,
  operation: string,
  statusMessage: string,
  work: () => Promise<{ exit_code: number; outputs?: Record<string, unknown> }>,
): Promise<Task> {
  const task = createTask(deployment, operation, statusMessage);
  void work().then((result) => {
    if (result.exit_code === 0) {
      updateTask(task.taskId, {
        status: "completed",
        statusMessage: `${operation} completed`,
        result: result.outputs ?? {},
      });
    } else {
      updateTask(task.taskId, {
        status: "failed",
        statusMessage: `${operation} failed`,
        error: { code: -32000, message: `exit ${result.exit_code}` },
      });
    }
  }).catch((err) => {
    updateTask(task.taskId, {
      status: "failed",
      statusMessage: `${operation} crashed`,
      error: { code: -32000, message: err instanceof Error ? err.message : String(err) },
    });
  });
  return task;
}

/**
 * Convert a Task to the tool-call result shape.
 *
 * Returns a standard CallToolResult with `content` (text the LLM reads to
 * learn the task is running and how to poll it) + `structuredContent`
 * (task metadata for programmatic clients) + `resultType: "task"` (for
 * clients like MCP Inspector that recognize the task result type).
 *
 * The `content` field is critical: without it, clients whose SDK parses
 * CallToolResult with a Zod schema that defaults `content` to `[]` and
 * strips unknown keys (resultType/taskId/status) see an empty result —
 * "Tool ran without output". The text content survives that parsing and
 * tells the LLM to poll via tasks/get.
 *
 * Poll interval guidance: the LLM should call tasks/get with the taskId
 * every pollIntervalMs (5s default) until status is completed/failed/cancelled.
 */
export function taskToResult(task: Task): CallToolResult {
  const text =
    `${task.operation} started (taskId: ${task.taskId}, status: ${task.status}). ` +
    `Poll with tasks/get(taskId: "${task.taskId}") every ${task.pollIntervalMs / 1000}s ` +
    `until status is completed/failed/cancelled. Current message: ${task.statusMessage}`;
  return {
    content: [{ type: "text", text }],
    structuredContent: {
      resultType: "task",
      taskId: task.taskId,
      status: task.status,
      statusMessage: task.statusMessage,
      createdAt: task.createdAt,
      lastUpdatedAt: task.lastUpdatedAt,
      ttlMs: task.ttlMs,
      pollIntervalMs: task.pollIntervalMs,
    },
  };
}
