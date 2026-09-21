import { describe, it, expect } from "vitest";
import { extractSecurityGroups } from "../src/extract/security_groups.js";

describe("extractSecurityGroups", () => {
  // Real terraform show -json structure: planned_values.root_module.resources[]
  // and values.root_module.resources[] put field values in `values`.
  // Cast as the expected input type — the fixture shape matches PlanJson but
  // Record<string, unknown> doesn't satisfy PlanResource structurally.
  const makePlan = (resources: Array<Record<string, unknown>>) => ({
    planned_values: { root_module: { resources } },
  }) as unknown as Parameters<typeof extractSecurityGroups>[0];

  describe("resource filtering", () => {
    it("extracts only _secgroup_rule resources", () => {
      const plan = makePlan([
        { address: "huaweicloud_networking_secgroup_rule.ssh", type: "huaweicloud_networking_secgroup_rule", values: { direction: "ingress", protocol: "tcp", ports: "22", remote_ip_prefix: "0.0.0.0/0" } },
        { address: "huaweicloud_vpc.main", type: "huaweicloud_vpc", values: {} },
        { address: "huaweicloud_compute_instance.web", type: "huaweicloud_compute_instance", values: {} },
      ]);
      const rules = extractSecurityGroups(plan);
      expect(rules).toHaveLength(1);
      expect(rules[0]!.address).toBe("huaweicloud_networking_secgroup_rule.ssh");
    });

    it("also extracts vpc_secgroup_rule (old provider type)", () => {
      const plan = makePlan([
        { address: "huaweicloud_vpc_secgroup_rule.http", type: "huaweicloud_vpc_secgroup_rule", values: { direction: "ingress", protocol: "tcp", port_range_min: 80, port_range_max: 80, remote_ip_prefix: "0.0.0.0/0" } },
      ]);
      const rules = extractSecurityGroups(plan);
      expect(rules).toHaveLength(1);
    });

    it("also extracts _security_group_rule resources", () => {
      const plan = makePlan([
        { address: "huaweicloud_networking_security_group_rule.https", type: "huaweicloud_networking_security_group_rule", values: { direction: "ingress", protocol: "tcp", ports: "443", remote_ip_prefix: "0.0.0.0/0" } },
      ]);
      const rules = extractSecurityGroups(plan);
      expect(rules).toHaveLength(1);
    });
  });

  describe("ports rendering", () => {
    it("uses ports string when present", () => {
      const plan = makePlan([
        { address: "r.ssh", type: "huaweicloud_networking_secgroup_rule", values: { ports: "22,80,443" } },
      ]);
      expect(extractSecurityGroups(plan)[0]!.ports).toBe("22,80,443");
    });

    it("falls back to port_range_min..max", () => {
      const plan = makePlan([
        { address: "r.range", type: "huaweicloud_vpc_secgroup_rule", values: { port_range_min: 8080, port_range_max: 8090 } },
      ]);
      expect(extractSecurityGroups(plan)[0]!.ports).toBe("8080..8090");
    });

    it("renders single port as plain number when min==max", () => {
      const plan = makePlan([
        { address: "r.single", type: "huaweicloud_vpc_secgroup_rule", values: { port_range_min: 443, port_range_max: 443 } },
      ]);
      expect(extractSecurityGroups(plan)[0]!.ports).toBe("443");
    });

    it("returns empty string when no port info", () => {
      const plan = makePlan([
        { address: "r.none", type: "huaweicloud_networking_secgroup_rule", values: {} },
      ]);
      expect(extractSecurityGroups(plan)[0]!.ports).toBe("");
    });
  });

  describe("rule_local_name", () => {
    it("extracts local name from resource address", () => {
      const plan = makePlan([
        { address: "huaweicloud_networking_secgroup_rule.ssh", type: "huaweicloud_networking_secgroup_rule", values: {} },
      ]);
      expect(extractSecurityGroups(plan)[0]!.rule_local_name).toBe("ssh");
    });

    it("returns full address when no dot", () => {
      const plan = makePlan([
        { address: "norule", type: "huaweicloud_networking_secgroup_rule", values: {} },
      ]);
      expect(extractSecurityGroups(plan)[0]!.rule_local_name).toBe("norule");
    });
  });

  describe("source/direction", () => {
    it("maps remote_ip_prefix to source", () => {
      const plan = makePlan([
        { address: "r.ingress", type: "huaweicloud_networking_secgroup_rule", values: { direction: "ingress", remote_ip_prefix: "10.0.0.0/8" } },
      ]);
      const rule = extractSecurityGroups(plan)[0]!;
      expect(rule.direction).toBe("ingress");
      expect(rule.source).toBe("10.0.0.0/8");
    });
  });

  describe("state vs plan input", () => {
    it("reads from values (state) not just planned_values (plan)", () => {
      const state = {
        values: { root_module: { resources: [
          { address: "r.ssh", type: "huaweicloud_networking_secgroup_rule", values: { ports: "22" } },
        ] } },
      };
      expect(extractSecurityGroups(state)).toHaveLength(1);
    });
  });

  describe("real terraform output structure", () => {
    // Verified against real `terraform show -json plan.tfplan` output.
    // planned_values.root_module.resources[] has `values` not `after`.
    it("parses real plan structure (values field, not after)", () => {
      const realPlan = {
        planned_values: {
          root_module: {
            resources: [
              {
                address: "huaweicloud_networking_secgroup_rule.ssh",
                mode: "managed",
                type: "huaweicloud_networking_secgroup_rule",
                name: "ssh",
                provider_name: "registry.terraform.io/huaweicloud/huaweicloud",
                schema_version: 0,
                values: {
                  direction: "ingress",
                  ethertype: "IPv4",
                  ports: "22",
                  protocol: "tcp",
                  remote_ip_prefix: "0.0.0.0/0",
                  description: null,
                  timeouts: null,
                },
                sensitive_values: {},
              },
            ],
          },
        },
      };
      const rules = extractSecurityGroups(realPlan);
      expect(rules).toHaveLength(1);
      expect(rules[0]!.direction).toBe("ingress");
      expect(rules[0]!.protocol).toBe("tcp");
      expect(rules[0]!.ports).toBe("22");
      expect(rules[0]!.source).toBe("0.0.0.0/0");
    });
  });
});
