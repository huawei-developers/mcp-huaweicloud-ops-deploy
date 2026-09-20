/**
 * cost.json zod schema (COST-DESIGN.zh.md §5).
 *
 * Two charging shapes (§5.3):
 *   Shape A (包周期类): mode prepaid|on-demand, period/period_unit/auto_renew
 *   Shape B (带宽类):  mode bandwidth|traffic, share_type/size
 *
 * cost.json uses lowercase/hyphen mode values (prepaid/on-demand); the
 * provider uses camelCase (prePaid/postPaid). The translation mapping
 * (§5.3) is documented in the design doc — server does NOT validate
 * charging↔.tf consistency (HCL semantics, out of scope).
 */

import { z } from "zod";

const chargingSchema = z
  .object({
    // Shape A
    mode: z.enum(["prepaid", "on-demand", "bandwidth", "traffic"]),
    period: z.number().int().positive().optional(),
    period_unit: z.enum(["month", "year"]).optional(),
    auto_renew: z.boolean().optional(),
    // Shape B
    share_type: z.enum(["PER", "WHOLE", "STANDARD"]).optional(),
    size: z.number().int().positive().optional(),
  })
  .superRefine((c, ctx) => {
    if (c.mode === "prepaid") {
      if (c.period === undefined) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "prepaid charging requires period", path: ["period"] });
      }
      if (c.period_unit === undefined) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "prepaid charging requires period_unit", path: ["period_unit"] });
      }
    }
  });

const costItemSchema = z.object({
  // References a networking.json identifier — a component id, a
  // network_objects id (eip/nat/lb), or a synthetic sub-resource id
  // (e.g. "ecs-1.system-disk" for a system disk attached to ecs-1).
  // The server validates that the resource matches a known component,
  // network_object, or a synthetic sub-resource (component.suffix).
  resource: z.string().min(1),
  source: z.enum(["reuse", "new"]),
  existing_id: z.string().optional(), // reuse 必填 (A层校验在 refine)
  spec: z.string().min(1),
  charging: chargingSchema,
  monthly: z.union([z.number(), z.literal(null)]), // null = 无法估价
});

export const CostSchema = z
  .object({
    $schema: z.string().optional(),
    currency: z.enum(["CNY", "USD"]),
    items: z.array(costItemSchema).min(1),
    total_monthly: z.union([z.number(), z.literal(null)]).optional(), // server overwrites
    tf_hash: z.union([z.string(), z.literal(null)]).optional(), // server overwrites
    estimated_at: z.string().optional(), // server overwrites
  })
  .superRefine((data, ctx) => {
    for (const [i, item] of data.items.entries()) {
      if (item.source === "reuse" && !item.existing_id) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `reuse item ${item.resource} requires existing_id`, path: ["items", i, "existing_id"] });
      }
    }
  });

export type Cost = z.infer<typeof CostSchema>;
export type CostItem = z.infer<typeof costItemSchema>;
export type Charging = z.infer<typeof chargingSchema>;
