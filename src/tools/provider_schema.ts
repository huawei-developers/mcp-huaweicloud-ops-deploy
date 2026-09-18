import type { CallToolResult, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import { fail, guard, ok } from "./errors.js";
import { deploymentParam } from "./index.js";
import { runTerraform } from "./terraform.js";

/**
 * provider_schema (§3.2).
 *
 * Runs `terraform providers schema -json` and extracts the huaweicloud
 * provider's schema. The full output is ~6MB (thousands of resource and
 * data-source schemas) — returning it whole would blow the LLM context. So:
 *   - With resource_type: return that single type's full schema (block,
 *     attributes, nested blocks) — small, focused.
 *   - Without resource_type: return only the type-name lists (resource_types
 *     + data_source_types), so the LLM can discover what exists and then
 *     drill in with a resource_type arg.
 *
 * The provider_schemas key is the full registry address
 * "registry.terraform.io/huaweicloud/huaweicloud", NOT the short name
 * "huaweicloud" (verified against terraform providers schema -json output).
 */
export function registerProviderSchemaTool(mcp: McpServer): void {
  mcp.registerTool(
    "provider_schema",
    {
      title: "提取 provider schema",
      description:
        "Extract the schema of the locally installed huaweicloud terraform " +
        "provider by running `terraform providers schema -json` in the deployment " +
        "directory. Without resource_type: return the list of all resource and " +
        "data-source type names (the full schema is ~6MB, too large to return " +
        "whole). Use the `filter` arg to narrow by substring (e.g. filter=\"vpc\" " +
        "returns huaweicloud_vpc, huaweicloud_vpc_route, ...). With resource_type: " +
        "return that type's full schema (attributes, types, required-ness, nested " +
        "blocks). Call AFTER terraform_init.",
      inputSchema: z.object({
        deployment: deploymentParam,
        resource_type: z.string().optional().describe('e.g. "huaweicloud_compute_instance"'),
        filter: z.string().optional().describe("Substring filter for type names (only when resource_type is absent)."),
      }),
    },
    guard(async (args) => {
      const result = await runTerraform(args.deployment, ["providers", "schema", "-json"]);
      if (result.exitCode !== 0) {
        return fail(`provider_schema failed: exit ${result.exitCode}: ${result.stderr}`);
      }
      try {
        const schema = JSON.parse(result.stdout) as {
          provider_schemas?: Record<string, unknown>;
        };
        const providerSchemas = schema.provider_schemas ?? {};
        // The key is the full registry address, not the short name.
        const hcKey = Object.keys(providerSchemas).find((k) =>
          k.includes("huaweicloud/huaweicloud"),
        );
        if (!hcKey) {
          return fail("huaweicloud provider not found in schema — run terraform_init first");
        }
        const hc = providerSchemas[hcKey] as {
          resource_schemas?: Record<string, unknown>;
          data_source_schemas?: Record<string, unknown>;
        };
        if (args.resource_type) {
          const rs = hc.resource_schemas?.[args.resource_type];
          if (rs) {
            return ok(JSON.stringify({ resource_type: args.resource_type, schema: rs }));
          }
          const ds = hc.data_source_schemas?.[args.resource_type];
          if (ds) {
            return ok(JSON.stringify({ data_source: args.resource_type, schema: ds }));
          }
          return fail(
            `resource_type not found: ${args.resource_type}. ` +
              `Call provider_schema without resource_type to list all available types.`,
          );
        }
        // Without resource_type: return type-name lists only (full schema is ~6MB).
        // Apply substring filter if given — narrows thousands of types to the relevant few.
        const f = args.filter?.toLowerCase();
        const matchFilter = (name: string) => !f || name.toLowerCase().includes(f);
        const resourceTypes = Object.keys(hc.resource_schemas ?? {}).filter(matchFilter);
        const dataSourceTypes = Object.keys(hc.data_source_schemas ?? {}).filter(matchFilter);
        return ok(
          JSON.stringify({
            resource_types: resourceTypes,
            data_source_types: dataSourceTypes,
            ...(f ? { filter: f, note: `filtered by substring "${f}"` } : {}),
          }),
        );
      } catch (err) {
        return fail(`failed to parse provider schema: ${err instanceof Error ? err.message : String(err)}`);
      }
    }),
  );
}
