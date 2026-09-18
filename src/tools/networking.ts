import type { CallToolResult, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { fail, guard, ok } from "./errors.js";
import { deploymentParam } from "./index.js";
import { NetworkingSchema } from "../schemas/networking.js";
import { updateSnapshot } from "../deployment/state.js";

/**
 * update_networking (§3.2 / NETWORKING-DESIGN.zh.md).
 *
 * inputSchema uses NetworkingSchema directly — the zod-to-JSON-Schema
 * conversion preserves the full structure (topology/components/network_objects),
 * so the client LLM sees exactly what fields to pass. superRefine (A-layer
 * reference consistency) is runtime validation only; it does NOT block the
 * JSON Schema export (verified: z.toJSONSchema emits the object shape
 * regardless of superRefine).
 */
export function registerNetworkingTool(mcp: McpServer): void {
  mcp.registerTool(
    "update_networking",
    {
      title: "组网设计落盘",
      description:
        "Write or update networking.json for a deployment. Three layers: " +
        "topology (VPC/subnets/route_tables/security_groups), network_objects " +
        "(eips/nat_gateways/loadbalancers), components (resource identity + " +
        "optional network attach). Design this before writing .tf — it is the " +
        "physical networking contract. Validates structure and A-layer reference " +
        "consistency (id uniqueness, subnet/sg/eip/nat refs).",
      inputSchema: z.object({
        deployment: deploymentParam,
        networking: NetworkingSchema,
      }),
    },
    guard(async (args) => {
      // Re-parse to run the superRefine validation (the inputSchema parse
      // already happened in the SDK, but superRefine issues are collected
      // separately — safeParse here gives us the full error detail).
      const parsed = NetworkingSchema.safeParse(args.networking);
      if (!parsed.success) {
        return fail(`schema validation: ${parsed.error.message}`);
      }
      try {
        await writeFile(join(args.deployment, "networking.json"), JSON.stringify(parsed.data, null, 2));
        await updateSnapshot(args.deployment, { networking_written: true, last_operation: "update_networking" });
        return ok(JSON.stringify({
          deployment: args.deployment,
          written: true,
          note: "IMPORTANT 自检：你是否已经把组网拓扑图展示给用户、并取得用户明确同意？若没有，禁止推进后续任何步骤（update_cost / 写 .tf / terraform_*）。拓扑须含 VPC + 子网 CIDR + 安全组规则 + network_objects 连接关系，优先 HTML 渲染。用户有修改意见则继续调整，直到用户明确采纳后再次调用该工具。",
        }));
      } catch (err) {
        return fail(`update_networking failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }),
  );
}
