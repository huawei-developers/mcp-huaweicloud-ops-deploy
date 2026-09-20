import type { CallToolResult, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { mkdir, readFile, readdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { fail, guard, ok } from "./errors.js";
import { destParam } from "./index.js";
import { extractArchive } from "../utils/tar.js";

/** terraform_examples_export (§3.2). */
export function registerExamplesTool(mcp: McpServer): void {
  mcp.registerTool(
    "terraform_examples_export",
    {
      title: "导出 terraform 编排示例",
      description:
        "Export HuaweiCloud terraform provider examples (.tf reference files) " +
        "to a target directory. Organized by cloud service category (ecs, vpc, " +
        "rds, ...). Serve as cross-resource assembly templates. Note: example " +
        "providers.tf may contain access_key lines from upstream docs — IGNORE " +
        "those (credentials go via env vars, never in .tf).",
      inputSchema: z.object({ dest: destParam }),
    },
    guard(async (args) => handleExamplesExport(args.dest)),
  );
}

async function handleExamplesExport(dest: string): Promise<CallToolResult> {
  // Refuse if dest exists and is non-empty — protect user data. The LLM might
  // point dest at a deployment workspace or any directory with existing files;
  // silent overwrite (adm-zip extractAllTo overwrite=true) would destroy them.
  // An empty or non-existent dest is fine.
  try {
    const entries = await readdir(dest);
    if (entries.length > 0) {
      return fail(
        `dest directory is not empty: ${dest}. ` +
          `Use an empty directory to avoid overwriting existing files.`,
      );
    }
  } catch {
    // Directory doesn't exist — proceed to create it.
  }

  const __dirname = dirname(fileURLToPath(import.meta.url));
  const zipPath = join(__dirname, "..", "data", "terraform-examples.zip");

  let zipBuf: Buffer;
  try {
    zipBuf = await readFile(zipPath);
  } catch {
    return fail(
      `examples data package not found at ${zipPath}. ` +
        `Run \`npm run fetch-examples\` to generate it before building.`,
    );
  }

  try {
    await mkdir(dest, { recursive: true });
  } catch (err) {
    return fail(`cannot create dest directory ${dest}: ${err instanceof Error ? err.message : String(err)}`);
  }

  const { writeFile: writeFileFs, unlink } = await import("node:fs/promises");
  const tmpZip = join(dest, ".terraform-examples.zip");
  await writeFileFs(tmpZip, zipBuf);
  try {
    const { files } = await extractArchive(tmpZip, dest);
    // List service categories (top-level dirs under examples/) so the LLM
    // knows what's available without reading the directory itself.
    const categories = await listCategories(dest);
    return ok(
      JSON.stringify({
        dest,
        files,
        categories,
        note: "Examples extracted. providers.tf may contain access_key lines from upstream docs — ignore those (credentials go via env vars).",
      }),
    );
  } catch (err) {
    return fail(`failed to extract examples: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    await unlink(tmpZip).catch(() => {});
  }
}

/** List service categories (top-level dirs under examples/). */
async function listCategories(dest: string): Promise<string[]> {
  try {
    const entries = await readdir(join(dest, "examples"), { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
  } catch {
    return [];
  }
}

