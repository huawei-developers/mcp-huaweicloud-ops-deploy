import { describe, it, expect } from "vitest";
import { CostSchema } from "../src/schemas/cost.js";

const validCost = {
  currency: "CNY",
  items: [
    { resource: "comp1", source: "new", spec: "s6.large.2", charging: { mode: "on-demand" }, monthly: 100 },
  ],
};

describe("CostSchema", () => {
  describe("structural validation", () => {
    it("accepts a valid cost spec", () => {
      const r = CostSchema.safeParse(validCost);
      expect(r.success).toBe(true);
    });

    it("rejects invalid currency", () => {
      const r = CostSchema.safeParse({ ...validCost, currency: "EUR" });
      expect(r.success).toBe(false);
    });

    it("requires at least one item", () => {
      const r = CostSchema.safeParse({ ...validCost, items: [] });
      expect(r.success).toBe(false);
    });

    it("accepts monthly as null (无法估价)", () => {
      const r = CostSchema.safeParse({
        ...validCost,
        items: [{ resource: "c1", source: "new", spec: "x", charging: { mode: "on-demand" }, monthly: null }],
      });
      expect(r.success).toBe(true);
    });
  });

  describe("charging shape A (prepaid)", () => {
    it("requires period for prepaid", () => {
      const r = CostSchema.safeParse({
        ...validCost,
        items: [{ resource: "c1", source: "new", spec: "x", charging: { mode: "prepaid" }, monthly: 100 }],
      });
      expect(r.success).toBe(false);
    });

    it("requires period_unit for prepaid", () => {
      const r = CostSchema.safeParse({
        ...validCost,
        items: [{ resource: "c1", source: "new", spec: "x", charging: { mode: "prepaid", period: 1 }, monthly: 100 }],
      });
      expect(r.success).toBe(false);
    });

    it("accepts prepaid with period + period_unit", () => {
      const r = CostSchema.safeParse({
        ...validCost,
        items: [{ resource: "c1", source: "new", spec: "x", charging: { mode: "prepaid", period: 1, period_unit: "month" }, monthly: 100 }],
      });
      expect(r.success).toBe(true);
    });
  });

  describe("charging shape B (bandwidth)", () => {
    it("accepts bandwidth mode with share_type + size", () => {
      const r = CostSchema.safeParse({
        ...validCost,
        items: [{ resource: "c1", source: "new", spec: "x", charging: { mode: "bandwidth", share_type: "PER", size: 5 }, monthly: 20 }],
      });
      expect(r.success).toBe(true);
    });
  });

  describe("reuse requires existing_id", () => {
    it("rejects reuse without existing_id", () => {
      const r = CostSchema.safeParse({
        ...validCost,
        items: [{ resource: "c1", source: "reuse", spec: "x", charging: { mode: "on-demand" }, monthly: null }],
      });
      expect(r.success).toBe(false);
    });

    it("accepts reuse with existing_id", () => {
      const r = CostSchema.safeParse({
        ...validCost,
        items: [{ resource: "c1", source: "reuse", existing_id: "i-xxx", spec: "x", charging: { mode: "on-demand" }, monthly: null }],
      });
      expect(r.success).toBe(true);
    });
  });
});
