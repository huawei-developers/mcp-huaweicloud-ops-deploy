import type { CallToolResult, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { readFile } from "node:fs/promises";

import { fail, guard, ok } from "./errors.js";
import { deploymentParam } from "./index.js";
import {
  DEPLOYMENT_STATE_FILE,
  ensureDeployment,
  isDeploymentDir,
  removeDeploymentDir,
  stateRecordedResourceCount,
  type DeploymentSnapshot,
} from "../deployment/state.js";

/**
 * create_deployment + delete_deployment (§3.2).
 *
 * create: create or reuse a deployment workspace directory, writing
 * .deployment.json (state snapshot). If the dir exists and is a deployment,
 * return existing info + status. If it exists but is non-empty and not a
 * deployment, refuse.
 *
 * delete: refuse if the deployment still has live cloud resources (check
 * terraform.tfstate); if clean, remove the directory.
 */
export function registerDeploymentTools(mcp: McpServer): void {
  mcp.registerTool(
    "create_deployment",
    {
      title: "创建部署工作区",
      description:
        "Create or reuse a deployment workspace directory. If the directory does " +
        "not exist, create it and write .deployment.json (state snapshot). Does NOT " +
        "create networking.json/cost.json placeholders. If the directory exists but " +
        "is not a deployment (non-empty, no .deployment.json), return an error.",
      inputSchema: z.object({ deployment: deploymentParam }),
    },
    guard(async (args) => handleCreate(args.deployment)),
  );

  mcp.registerTool(
    "delete_deployment",
    {
      title: "删除部署工作区",
      description:
        "Delete a deployment workspace directory. Refuses if the deployment still " +
        "has live cloud resources — checks terraform.tfstate; if resources exist, " +
        "run terraform_destroy first. If no resources, removes the directory.",
      inputSchema: z.object({ deployment: deploymentParam }),
    },
    guard(async (args) => handleDelete(args.deployment)),
  );
}

async function handleCreate(dir: string): Promise<CallToolResult> {
  if (await isDeploymentDir(dir)) {
    // Existing deployment — return current status snapshot.
    const statePath = `${dir}/${DEPLOYMENT_STATE_FILE}`;
    try {
      const raw = await readFile(statePath, "utf8");
      const snapshot = JSON.parse(raw) as DeploymentSnapshot;
      return ok(
        JSON.stringify({ deployment: dir, status: "existing", snapshot }),
      );
    } catch {
      return fail(`failed to read ${statePath}`);
    }
  }
  try {
    const snapshot = await ensureDeployment(dir);
    return ok(
      JSON.stringify({ deployment: dir, status: "created", snapshot }),
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("not empty")) {
      return fail("directory is not empty and not a deployment");
    }
    return fail(`create_deployment failed: ${msg}`);
  }
}

async function handleDelete(dir: string): Promise<CallToolResult> {
  if (!(await isDeploymentDir(dir))) {
    return fail("not a deployment directory (no .deployment.json)");
  }
  const recordedCount = await stateRecordedResourceCount(dir);
  if (recordedCount > 0) {
    return fail(
      `deployment has ${recordedCount} resources recorded in tfstate — run terraform_destroy first`,
    );
  }
  try {
    await removeDeploymentDir(dir);
    return ok(JSON.stringify({ deployment: dir, status: "deleted" }));
  } catch (err) {
    return fail(`delete_deployment failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
