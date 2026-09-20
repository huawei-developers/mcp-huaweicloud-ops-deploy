import type { CallToolResult, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { fail, guard, ok } from "./errors.js";
import { deploymentParam } from "./index.js";
import { CostSchema, type CostItem } from "../schemas/cost.js";
import { updateSnapshot } from "../deployment/state.js";

/**
 * update_cost (§3.2 / COST-DESIGN.zh.md).
 *
 * inputSchema uses CostSchema directly — the zod-to-JSON-Schema conversion
 * preserves the full structure (currency/items/charging), so the client LLM
 * sees exactly what fields to pass. superRefine (reuse→existing_id check) is
 * runtime validation only; it does NOT block the JSON Schema export.
 *
 * Cross-file reference check (§5.2 A-layer): items[].resource must reference
 * a component id in networking.json. This CANNOT be done in the zod schema
 * (it validates one file; the reference target is another file). It's done
 * in the handler after schema parse succeeds.
 */
export function registerCostTool(mcp: McpServer): void {
  mcp.registerTool(
    "update_cost",
    {
      title: "规格计费落盘",
      description:
        "Write or update cost.json for a deployment. Records spec + charging + " +
        "price + source (reuse/new) per component. Server validates structure + " +
        "A-layer refs (resource → networking components), auto-computes " +
        "total_monthly (sum of new items only), sets tf_hash=null, writes " +
        "estimated_at. Called BEFORE writing .tf (cost.json precedes .tf).",
      inputSchema: z.object({
        deployment: deploymentParam,
        cost: CostSchema,
      }),
    },
    guard(async (args) => {
      // Re-parse to run superRefine validation with full error detail.
      const parsed = CostSchema.safeParse(args.cost);
      if (!parsed.success) {
        return fail(`schema validation: ${parsed.error.message}`);
      }
      const cost = parsed.data;

      // Cross-file reference check: items[].resource → networking.json components[].id.
      // §5.2 A-layer — server truly uses this (cost gate + apply gate depend on it).
      const refErrors = await validateResourceRefs(args.deployment, cost.items);
      if (refErrors.length > 0) {
        return fail(`schema validation: ${refErrors.join("; ")}`);
      }

      // Server-written fields (§5.2): total_monthly, tf_hash, estimated_at.
      cost.total_monthly = computeTotalMonthly(cost.items);
      cost.tf_hash = null;
      cost.estimated_at = new Date().toISOString();
      try {
        await writeFile(join(args.deployment, "cost.json"), JSON.stringify(cost, null, 2));
        await updateSnapshot(args.deployment, { cost_written: true, last_operation: "update_cost" });
        return ok(JSON.stringify({ deployment: args.deployment, written: true, total_monthly: cost.total_monthly }));
      } catch (err) {
        return fail(`update_cost failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }),
  );
}

/**
 * Validate that every items[].resource references a component id in
 * networking.json. Returns a list of error messages (empty = ok).
 *
 * If networking.json doesn't exist, that's not a cost-schema error — it's
 * an ordering error (update_networking should be called first). We return
 * a single error telling the client to call update_networking first.
 */
async function validateResourceRefs(deployment: string, items: CostItem[]): Promise<string[]> {
  let networking: {
    components?: Array<{ id: string }>;
    network_objects?: {
      eips?: Array<{ id: string }>;
      nat_gateways?: Array<{ id: string }>;
      loadbalancers?: Array<{ id: string }>;
    };
  };
  try {
    const raw = await readFile(join(deployment, "networking.json"), "utf8");
    networking = JSON.parse(raw);
  } catch {
    return ["networking.json not found — call update_networking first (cost.json items[].resource must reference networking components or network_objects)"];
  }

  // Collect all valid resource identifiers: component ids, network_object
  // ids (eip/nat/lb), and synthetic sub-resource ids (component + ".suffix",
  // e.g. "ecs-1.system-disk" for a system disk attached to ecs-1).
  const validIds = new Set<string>();
  for (const c of networking.components ?? []) validIds.add(c.id);
  for (const e of networking.network_objects?.eips ?? []) validIds.add(e.id);
  for (const n of networking.network_objects?.nat_gateways ?? []) validIds.add(n.id);
  for (const l of networking.network_objects?.loadbalancers ?? []) validIds.add(l.id);
  if (validIds.size === 0) {
    return ["networking.json has no components or network_objects — cost.json items[].resource has nothing to reference"];
  }

  const errors: string[] = [];
  for (const item of items) {
    // Allow exact match or synthetic sub-resource (component.suffix).
    const base = item.resource.split(".")[0] ?? item.resource;
    if (!validIds.has(item.resource) && !validIds.has(base)) {
      errors.push(`items[].resource "${item.resource}" references unknown component/network_object (not in networking.json)`);
    }
  }
  return errors;
}

/** Sum monthly of new items only (§2.2). null treated as 0; all-null → null. */
function computeTotalMonthly(items: CostItem[]): number | null {
  const newItems = items.filter((i) => i.source === "new");
  let allNull = true;
  const sum = newItems.reduce((acc, i) => {
    if (i.monthly === null) return acc;
    allNull = false;
    return acc + i.monthly;
  }, 0);
  return allNull ? null : sum;
}
