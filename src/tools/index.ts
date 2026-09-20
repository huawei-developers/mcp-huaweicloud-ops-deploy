import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import { registerAuthTool } from "./auth.js";
import { registerDeploymentTools } from "./deployment.js";
import { registerNetworkingTool } from "./networking.js";
import { registerCostTool } from "./cost.js";
import { registerOpenApiTools } from "./openapi.js";
import { registerExamplesTool } from "./examples.js";
import { registerExistingResourcesTool } from "./existing_resources.js";
import { registerProviderSchemaTool } from "./provider_schema.js";
import { registerTerraformTools } from "./terraform.js";

/**
 * Register all 18 tools on the McpServer instance.
 *
 * Tool count (DESIGN.zh.md §3.1):
 *   deployment (2) + state files (2) + huaweicloud capability (5) + terraform (9) = 18
 *
 * 6 of the terraform tools (install/init/plan/apply/destroy/refresh) are
 * long-running and return CreateTaskResult (task handle) — the client polls
 * via tasks/get and cancels via tasks/cancel (§8.2).
 */
export function registerAllTools(mcp: McpServer): void {
  // 部署目录管理 (2)
  registerDeploymentTools(mcp);

  // 状态文件 (2)
  registerNetworkingTool(mcp);
  registerCostTool(mcp);

  // 华为云能力 (5)
  registerAuthTool(mcp);
  registerOpenApiTools(mcp);
  registerExamplesTool(mcp);
  registerExistingResourcesTool(mcp);
  // provider_schema is grouped with terraform capability in §3.2 but
  // registered here for ordering clarity — it reads local terraform state.

  // Terraform 执行 (8)
  registerProviderSchemaTool(mcp);
  registerTerraformTools(mcp);
}

/**
 * Shared zod string schema for the `deployment` parameter — an absolute or
 * relative path to the deployment workspace directory. Used by every tool
 * that operates on a deployment.
 */
export const deploymentParam = z.string().min(1).describe("部署工作区目录路径（绝对或相对）");

/**
 * Shared zod string schema for `dest` — the reference-data extraction
 * target, distinct from the deployment workspace (§3.2: "distinct from
 * the deployment workspace — this is where reference data is extracted").
 */
export const destParam = z.string().min(1).describe("导出目标目录路径（参考数据，不是 deployment 工作区）");
