import { describe, it, expect } from "vitest";
import { summaryFromPlanJson } from "../src/tools/terraform.js";

// Real `terraform show -json <plan>` structure: resource_changes[].change.actions
const planWith = (changes: Array<{ address: string; actions: string[] }>) => ({
  resource_changes: changes.map((c) => ({
    address: c.address,
    type: c.address.split(".")[0],
    change: { actions: c.actions },
  })),
});

describe("summaryFromPlanJson", () => {
  it("counts create/update/delete from primary action", () => {
    const plan = planWith([
      { address: "huaweicloud_vpc.main", actions: ["create"] },
      { address: "huaweicloud_vpc_subnet.sub", actions: ["create"] },
      { address: "huaweicloud_compute_instance.web", actions: ["update"] },
      { address: "huaweicloud_vpc.old", actions: ["delete"] },
    ]);
    expect(summaryFromPlanJson(plan)).toEqual({ create: 2, change: 1, destroy: 1 });
  });

  it("returns zeros when all no-op", () => {
    const plan = planWith([
      { address: "huaweicloud_vpc.main", actions: ["no-op"] },
      { address: "huaweicloud_vpc_subnet.sub", actions: ["no-op"] },
    ]);
    expect(summaryFromPlanJson(plan)).toEqual({ create: 0, change: 0, destroy: 0 });
  });

  it("handles composite actions (create-then-delete = replace) by taking primary", () => {
    // terraform uses ["create","delete"] for replace. Primary = create.
    const plan = planWith([
      { address: "huaweicloud_compute_instance.web", actions: ["create", "delete"] },
    ]);
    expect(summaryFromPlanJson(plan)).toEqual({ create: 1, change: 0, destroy: 0 });
  });

  it("skips resources with empty actions", () => {
    const plan = planWith([
      { address: "huaweicloud_vpc.main", actions: ["create"] },
      { address: "huaweicloud_vpc.empty", actions: [] },
    ]);
    expect(summaryFromPlanJson(plan)).toEqual({ create: 1, change: 0, destroy: 0 });
  });

  it("returns zeros when resource_changes absent", () => {
    expect(summaryFromPlanJson({})).toEqual({ create: 0, change: 0, destroy: 0 });
    expect(summaryFromPlanJson(null)).toEqual({ create: 0, change: 0, destroy: 0 });
    expect(summaryFromPlanJson(undefined)).toEqual({ create: 0, change: 0, destroy: 0 });
  });

  it("returns zeros when resource_changes is empty array", () => {
    const plan = { resource_changes: [] };
    expect(summaryFromPlanJson(plan)).toEqual({ create: 0, change: 0, destroy: 0 });
  });

  // Regression: the bug this function fixes. The old parsePlanSummary looked for
  // type:"summary" in plan -json stdout, but terraform 1.9+ emits type:
  // "change_summary" in -out mode, so it returned 0 even when 4 resources were
  // being created. This test pins the fix: derive from resource_changes, not stdout.
  it("regression: 4 creates counted correctly (was 0 before fix)", () => {
    const plan = planWith([
      { address: "huaweicloud_networking_secgroup.sg1", actions: ["create"] },
      { address: "huaweicloud_networking_secgroup_rule.ssh", actions: ["create"] },
      { address: "huaweicloud_vpc.vpc1", actions: ["create"] },
      { address: "huaweicloud_vpc_subnet.subnet1", actions: ["create"] },
    ]);
    expect(summaryFromPlanJson(plan)).toEqual({ create: 4, change: 0, destroy: 0 });
  });
});
