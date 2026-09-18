/**
 * cost_gate.ts — cost.json existence + tf_hash state machine (§6.3 门 2+3).
 *
 * The tf_hash logic (COST-DESIGN.zh.md §4):
 *   - cost.json written BEFORE .tf, so tf_hash is null on write
 *   - null  → allow (first time / last apply failed); fill hash after success
 *   - non-null → recompute current .tf SHA256, compare; mismatch rejects
 *
 * "Fill after success, not before" (§4.1): apply failure doesn't fill,
 * so retry after a bug fix doesn't demand a pointless cost recompute.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { Cost } from "../schemas/cost.js";
import { computeTfHash } from "../utils/hash.js";

export async function loadCost(dir: string): Promise<Cost> {
  const raw = await readFile(join(dir, "cost.json"), "utf8");
  return JSON.parse(raw) as Cost;
}

export async function costJsonExists(dir: string): Promise<boolean> {
  try {
    await readFile(join(dir, "cost.json"), "utf8");
    return true;
  } catch {
    return false;
  }
}

/**
 * Run the cost gate. Returns the cost.json (with its tf_hash) so the
 * caller can fill it after a successful apply.
 *
 * @throws Error if cost.json missing or tf_hash mismatch
 */
export async function runCostGate(dir: string): Promise<Cost> {
  if (!(await costJsonExists(dir))) {
    throw new Error("cost.json not found — call update_cost first");
  }
  const cost = await loadCost(dir);

  if (cost.tf_hash === null || cost.tf_hash === undefined) {
    // First time / last failed — allow. Don't fill yet (fill after success).
    return cost;
  }

  // Non-null — recompute and compare.
  const currentHash = await computeTfHash(dir);
  if (currentHash !== cost.tf_hash) {
    throw new Error(
      "cost.json.tf_hash does not match current .tf files — " +
        ".tf changed after cost estimate, re-run update_cost",
    );
  }
  return cost;
}

/** Fill tf_hash in cost.json after a successful apply (§6.3). */
export async function fillTfHash(dir: string): Promise<void> {
  const cost = await loadCost(dir);
  cost.tf_hash = await computeTfHash(dir);
  const { writeFile } = await import("node:fs/promises");
  await writeFile(join(dir, "cost.json"), JSON.stringify(cost, null, 2));
}
