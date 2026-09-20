/**
 * Security-group rule extraction from plan/state JSON (§6.4).
 *
 * After terraform_plan / terraform_state, the server extracts all
 * secgroup rules from the structured JSON output and surfaces them as a
 * flat list — pulling rules buried deep in the plan to the top for human
 * review. No "reasonableness" judgment (that needs AI); just formatting.
 *
 * Provider has two port-field shapes (§6.4 fix):
 *   - `ports` (string, e.g. "80,443") — networking_secgroup_rule
 *   - `port_range_min`/`port_range_max` (numbers) — vpc_secgroup_rule
 * Extraction prefers `ports`, falls back to the range.
 */

export interface SecgroupRuleView {
  address: string; // e.g. huaweicloud_networking_secgroup_rule.ssh
  rule_local_name: string; // the rule's local name (e.g. "ssh"), extracted from address
  direction: string;
  protocol: string;
  ports: string;
  source: string; // remote_ip_prefix — same field for ingress/egress
}

interface PlanResource {
  address: string;
  type: string;
  /** Field values — present in both planned_values (plan) and values (state). */
  values?: Record<string, unknown>;
}

interface PlanJson {
  planned_values?: { root_module?: { resources?: PlanResource[] } };
  values?: { root_module?: { resources?: PlanResource[] } };
}

/** Extract secgroup rules from a `terraform show -json` plan or state output. */
export function extractSecurityGroups(planOrStateJson: PlanJson): SecgroupRuleView[] {
  const resources = planOrStateJson.planned_values?.root_module?.resources
    ?? planOrStateJson.values?.root_module?.resources
    ?? [];

  const rules: SecgroupRuleView[] = [];
  for (const res of resources) {
    if (!res.type.endsWith("_secgroup_rule") && !res.type.endsWith("_security_group_rule")) {
      continue;
    }
    const vals = res.values ?? {};
    // §6.4: prefer `ports`, fall back to port_range_min..max
    const ports = portsToString(vals);
    rules.push({
      address: res.address,
      rule_local_name: extractRuleLocalName(res.address),
      direction: String(vals["direction"] ?? ""),
      protocol: String(vals["protocol"] ?? ""),
      ports,
      source: String(vals["remote_ip_prefix"] ?? ""),
    });
  }
  return rules;
}

/** Render ports: prefer `ports` string, else `port_range_min..port_range_max`. */
function portsToString(vals: Record<string, unknown>): string {
  const p = vals["ports"];
  if (typeof p === "string" && p !== "") return p;
  const min = vals["port_range_min"];
  const max = vals["port_range_max"];
  if (typeof min === "number" && typeof max === "number") {
    return min === max ? String(min) : `${min}..${max}`;
  }
  return "";
}

/**
 * Extract the rule's local name from its address.
 * e.g. huaweicloud_networking_secgroup_rule.ssh → "ssh"
 *
 * Plan-time security_group_id is "known after apply" — we CANNOT reliably
 * correlate a rule to its owning secgroup from the plan JSON. So we surface
 * only the rule's local name as a label, not a secgroup resource address.
 */
function extractRuleLocalName(ruleAddress: string): string {
  const dotIdx = ruleAddress.indexOf(".");
  if (dotIdx < 0) return ruleAddress;
  return ruleAddress.slice(dotIdx + 1);
}
