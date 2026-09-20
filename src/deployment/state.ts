/**
 * Deployment workspace state (§4.3 .deployment.json).
 *
 * A deployment directory is identified by the presence of
 * .deployment.json. The file holds a status snapshot — not an operation
 * log. Server updates it on each state change (update_networking /
 * update_cost / terraform_apply / terraform_destroy). The client LLM
 * never writes this file.
 */

import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { SERVER_VERSION } from "../version.js";

export const DEPLOYMENT_STATE_FILE = ".deployment.json";

export interface DeploymentSnapshot {
  created_at: string;
  created_with: string;
  server_version: string;
  account?: { name: string; account_id: string };
  status: {
    networking_written: boolean;
    cost_written: boolean;
    applied: boolean;
    destroyed: boolean;
    last_operation: string;
    last_operation_at: string;
  };
}

/** Check whether a directory is a deployment (has .deployment.json). */
export async function isDeploymentDir(dir: string): Promise<boolean> {
  try {
    await readFile(join(dir, DEPLOYMENT_STATE_FILE), "utf8");
    return true;
  } catch {
    return false;
  }
}

/** Create a deployment directory + initial .deployment.json. Refuse if non-empty. */
export async function ensureDeployment(dir: string): Promise<DeploymentSnapshot> {
  let entries: string[] = [];
  try {
    entries = await readdir(dir);
  } catch {
    // Doesn't exist — create it.
  }
  if (entries.length > 0) {
    throw new Error("directory is not empty and not a deployment");
  }
  await mkdir(dir, { recursive: true });
  const now = new Date().toISOString();
  const snapshot: DeploymentSnapshot = {
    created_at: now,
    created_with: "huaweicloud-ops-deploy",
    server_version: SERVER_VERSION,
    status: {
      networking_written: false,
      cost_written: false,
      applied: false,
      destroyed: false,
      last_operation: "create_deployment",
      last_operation_at: now,
    },
  };
  await writeFile(join(dir, DEPLOYMENT_STATE_FILE), JSON.stringify(snapshot, null, 2));
  return snapshot;
}

/** Update the status snapshot (called by other modules after state changes). */
export async function updateSnapshot(
  dir: string,
  patch: Partial<DeploymentSnapshot["status"]> & { last_operation: string },
): Promise<void> {
  const raw = await readFile(join(dir, DEPLOYMENT_STATE_FILE), "utf8");
  const snap = JSON.parse(raw) as DeploymentSnapshot;
  snap.status = { ...snap.status, ...patch, last_operation_at: new Date().toISOString() };
  await writeFile(join(dir, DEPLOYMENT_STATE_FILE), JSON.stringify(snap, null, 2));
}

/**
 * Backfill the account field in .deployment.json if it's empty and the
 * server is now authenticated (§4.3: "后续 auth 后 server 操作该 deployment
 * 时补写").
 *
 * Called by runTerraform after resolveTerraformEnv succeeds. The account
 * identity was resolved at auth time (GET /v3/projects → domain_id + name)
 * and stored alongside the credentials; runTerraform reads it via
 * loadAccount() — no IAM re-query here. This is a stateless write: the
 * account is only backfilled once (idempotent — already-filled is a no-op).
 *
 * This is intentionally a no-op when:
 *   - the deployment has no .deployment.json (not a deployment dir)
 *   - account is already filled (idempotent)
 *   - loadAccount returns null (not authenticated, or payload predates
 *     IAM verification wiring)
 */
export async function backfillAccount(dir: string, account: { name: string; account_id: string }): Promise<void> {
  let snap: DeploymentSnapshot;
  try {
    const raw = await readFile(join(dir, DEPLOYMENT_STATE_FILE), "utf8");
    snap = JSON.parse(raw) as DeploymentSnapshot;
  } catch {
    return; // Not a deployment dir — silently skip.
  }
  if (snap.account) return; // Already filled — idempotent.
  snap.account = account;
  await writeFile(join(dir, DEPLOYMENT_STATE_FILE), JSON.stringify(snap, null, 2));
}

/**
 * Count resources recorded in terraform.tfstate (0 = clean / never applied).
 *
 * This is the count RECORDED in the state file, NOT the live count on the
 * cloud — tfstate may be stale if resources were changed outside terraform.
 * For the live count, run terraform_refresh first. Used by delete_deployment
 * and terraform_destroy to guard against destroying/emptying a deployment
 * that still has recorded resources.
 */
export async function stateRecordedResourceCount(dir: string): Promise<number> {
  try {
    const raw = await readFile(join(dir, "terraform.tfstate"), "utf8");
    const state = JSON.parse(raw) as { resources?: unknown[] };
    return state.resources?.length ?? 0;
  } catch {
    return 0;
  }
}

/** Remove the deployment directory. */
export async function removeDeploymentDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}
