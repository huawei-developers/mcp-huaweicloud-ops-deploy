/**
 * Build the server into a scratch directory, for tests that spawn it.
 *
 * One test drives the real server process over stdio, because nothing less can
 * prove that a tool *registration* is wired to the read-only gate — a unit test
 * on the gate function passes whether or not any call site uses it. That test
 * needs a built entry point, and `npm test` runs `tsc --noEmit` and vitest
 * without building, so on a fresh checkout the spawn would fail with a
 * connection error rather than a verdict about the gate.
 *
 * Rather than make `test` depend on `build`, this compiles on demand to a temp
 * directory:
 *
 *   - `npm run build` also requires `src/data/terraform-examples.zip`, which is
 *     git-ignored and absent on a fresh checkout, and fetching it clones the
 *     provider repo over the network. Tests must not need that.
 *   - Compiling alone is enough for the code under test; only the permission
 *     registry is read from `data/`, and it *is* committed, so it is copied
 *     alongside.
 *
 * The result is cached per process and removed on exit. Vitest isolates test
 * files, so this runs once for the one file that spawns a server.
 *
 * The build directory is a fixed path inside the package, for two reasons: a
 * build placed outside the package starts and immediately dies with
 * ERR_MODULE_NOT_FOUND for the first bare import, and a fixed name means a
 * run that is killed before its exit hook fires still leaves at most one
 * directory, which the next run clears. It is git-ignored.
 *
 * @module test/helpers/build-server
 */

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Package root, resolved from this file rather than the cwd. */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Scratch build directory, git-ignored. */
const BUILD_DIR = join(ROOT, ".test-build");

/** Cached entry point, once built. */
let entry: string | undefined;

/**
 * Compile the server and return the path to its entry point.
 *
 * @returns absolute path to a runnable `index.js`.
 * @throws if the compile fails, with tsc's own diagnostics attached.
 */
export function serverEntryPoint(): string {
  if (entry !== undefined) return entry;

  rmSync(BUILD_DIR, { recursive: true, force: true });
  mkdirSync(BUILD_DIR, { recursive: true });

  const tsc = join(ROOT, "node_modules", ".bin", "tsc");
  try {
    execFileSync(tsc, ["--outDir", join(BUILD_DIR, "dist")], { cwd: ROOT, stdio: "pipe" });
  } catch (error) {
    // Surface tsc's output; a bare "command failed" would hide the reason.
    const out = (error as { stdout?: Buffer }).stdout?.toString() ?? "";
    rmSync(BUILD_DIR, { recursive: true, force: true });
    throw new Error(`test server build failed:\n${out}`);
  }

  const registry = join(ROOT, "src", "data", "permission-registry.json");
  if (!existsSync(registry)) {
    throw new Error(
      `permission registry missing at ${registry} — run \`npm run build-permission-registry\``,
    );
  }
  const dataDir = join(BUILD_DIR, "dist", "data");
  mkdirSync(dataDir, { recursive: true });
  cpSync(registry, join(dataDir, "permission-registry.json"));

  // `version.ts` reads the package version from `../package.json`, which after
  // compilation resolves to the build root rather than the repo's. Without it
  // the server throws ERR_MODULE_NOT_FOUND before it can serve anything.
  cpSync(join(ROOT, "package.json"), join(BUILD_DIR, "package.json"));

  entry = join(BUILD_DIR, "dist", "index.js");
  return entry;
}

/** Remove the build directory. Registered as an exit hook on first build. */
export function removeServerBuild(): void {
  rmSync(BUILD_DIR, { recursive: true, force: true });
  entry = undefined;
}

process.once("exit", removeServerBuild);