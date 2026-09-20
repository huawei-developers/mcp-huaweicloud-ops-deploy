import { describe, it, expect } from "vitest";
import { NetworkingSchema } from "../src/schemas/networking.js";

const validBase = {
  topology: {
    vpc: { name: "vpc-test", cidr: "192.168.0.0/16" },
    subnets: [{ name: "subnet-test", cidr: "192.168.0.0/24", az: "cn-north-4a" }],
    security_groups: [{ name: "sg-test", rules: [{ direction: "ingress", protocol: "tcp", ports: "22", source: "0.0.0.0/0" }] }],
  },
  components: [{ id: "comp1", type: "huaweicloud_vpc" }],
};

describe("NetworkingSchema", () => {
  describe("structural validation (B layer)", () => {
    it("accepts a valid networking spec", () => {
      const r = NetworkingSchema.safeParse(validBase);
      expect(r.success).toBe(true);
    });

    it("rejects invalid CIDR", () => {
      const r = NetworkingSchema.safeParse({
        ...validBase,
        topology: { ...validBase.topology, vpc: { name: "v", cidr: "not-a-cidr" } },
      });
      expect(r.success).toBe(false);
    });

    it("requires at least one subnet", () => {
      const r = NetworkingSchema.safeParse({
        ...validBase,
        topology: { ...validBase.topology, subnets: [] },
      });
      expect(r.success).toBe(false);
    });

    it("requires at least one security group", () => {
      const r = NetworkingSchema.safeParse({
        ...validBase,
        topology: { ...validBase.topology, security_groups: [] },
      });
      expect(r.success).toBe(false);
    });

    it("requires component type to start with huaweicloud_", () => {
      const r = NetworkingSchema.safeParse({
        ...validBase,
        components: [{ id: "c1", type: "aws_vpc" }],
      });
      expect(r.success).toBe(false);
    });
  });

  describe("A-layer reference validation", () => {
    it("rejects duplicate subnet name", () => {
      const r = NetworkingSchema.safeParse({
        ...validBase,
        topology: {
          ...validBase.topology,
          subnets: [
            { name: "dup", cidr: "10.0.0.0/24", az: "a" },
            { name: "dup", cidr: "10.0.1.0/24", az: "b" },
          ],
        },
      });
      expect(r.success).toBe(false);
    });

    it("rejects duplicate component id", () => {
      const r = NetworkingSchema.safeParse({
        ...validBase,
        components: [
          { id: "dup", type: "huaweicloud_vpc" },
          { id: "dup", type: "huaweicloud_vpc" },
        ],
      });
      expect(r.success).toBe(false);
    });

    it("rejects component referencing unknown subnet", () => {
      const r = NetworkingSchema.safeParse({
        ...validBase,
        components: [{ id: "c1", type: "huaweicloud_compute_instance", subnet: "nonexistent" }],
      });
      expect(r.success).toBe(false);
    });

    it("rejects component referencing unknown security_group", () => {
      const r = NetworkingSchema.safeParse({
        ...validBase,
        components: [{ id: "c1", type: "huaweicloud_compute_instance", security_groups: ["nonexistent"] }],
      });
      expect(r.success).toBe(false);
    });

    it("rejects ingress rule without source", () => {
      const r = NetworkingSchema.safeParse({
        ...validBase,
        topology: {
          ...validBase.topology,
          security_groups: [{ name: "sg", rules: [{ direction: "ingress", protocol: "tcp", ports: "22" }] }],
        },
      });
      expect(r.success).toBe(false);
    });

    it("rejects egress rule without destination", () => {
      const r = NetworkingSchema.safeParse({
        ...validBase,
        topology: {
          ...validBase.topology,
          security_groups: [{ name: "sg", rules: [{ direction: "egress", protocol: "tcp", ports: "80" }] }],
        },
      });
      expect(r.success).toBe(false);
    });

    it("rejects subnet referencing unknown route_table", () => {
      const r = NetworkingSchema.safeParse({
        ...validBase,
        topology: {
          ...validBase.topology,
          subnets: [{ name: "s", cidr: "10.0.0.0/24", az: "a", route_table: "nonexistent" }],
        },
      });
      expect(r.success).toBe(false);
    });

    it("accepts valid route_table reference", () => {
      const r = NetworkingSchema.safeParse({
        ...validBase,
        topology: {
          ...validBase.topology,
          route_tables: [{ name: "rt-test", routes: [] }],
          subnets: [{ name: "subnet-test", cidr: "192.168.0.0/24", az: "a", route_table: "rt-test" }],
        },
      });
      expect(r.success).toBe(true);
    });
  });

  describe("network_objects references", () => {
    it("rejects eip attached_to unknown component", () => {
      const r = NetworkingSchema.safeParse({
        ...validBase,
        network_objects: {
          eips: [{ id: "eip1", bandwidth: "5Mbit/s", attached_to: { kind: "instance", target: "nonexistent" } }],
        },
      });
      expect(r.success).toBe(false);
    });

    it("rejects nat referencing unknown eip", () => {
      const r = NetworkingSchema.safeParse({
        ...validBase,
        network_objects: {
          nat_gateways: [{ id: "nat1", subnet: "subnet-test", snat_eip: "nonexistent", snat_source_cidr: "192.168.0.0/16" }],
        },
      });
      expect(r.success).toBe(false);
    });

    it("rejects nat referencing unknown subnet", () => {
      const r = NetworkingSchema.safeParse({
        ...validBase,
        network_objects: {
          eips: [{ id: "eip1", bandwidth: "5Mbit/s", attached_to: { kind: "nat", target: "nat1" } }],
          nat_gateways: [{ id: "nat1", subnet: "nonexistent", snat_eip: "eip1", snat_source_cidr: "192.168.0.0/16" }],
        },
      });
      expect(r.success).toBe(false);
    });
  });
});
