/**
 * networking.json zod schema (NETWORKING-DESIGN.zh.md §4/§5).
 *
 * Three layers: topology (infra), network_objects (eips/nat/lb),
 * components (resource identity + optional network attach).
 *
 * Validation tiers (§6):
 *   A (server hard-validates): reference consistency, uniqueness, CIDR
 *   B (structural): enums, required, port ranges
 *   C (loose): ports syntax, source CIDR, description — non-empty only
 *
 * The server reads its validation contract from this in-code schema, NOT
 * from the file's $schema field. $schema is just a label; the file is a
 * request body, not a persistent contract — server upgrades don't
 * promise to accept old files (re-run update_networking).
 */

import { z } from "zod";

const cidrRegex = /^(?:\d{1,3}\.){3}\d{1,3}\/\d{1,2}$/;
const cidr = z.string().regex(cidrRegex, "invalid CIDR");

const az = z.string().min(1);

const routeSchema = z.object({
  destination: cidr,
  next_hop_type: z.enum(["nat", "vpn", "peering", "internet"]),
  next_hop: z.string().min(1),
});

const routeTableSchema = z.object({
  name: z.string().min(1),
  routes: z.array(routeSchema), // may be empty (default route only)
});

const secgroupRuleSchema = z.object({
  direction: z.enum(["ingress", "egress"]),
  protocol: z.enum(["tcp", "udp", "icmp", "icmpv6", "any"]).describe("HuaweiCloud provider supports tcp/udp/icmp/icmpv6. \"any\" means no protocol filter — in .tf omit the protocol argument (provider default)."),
  ports: z.string().min(1), // C层: 字符串即可,server 不校验语法
  source: z.string().optional(), // ingress 时必填 (A层校验在 refine)
  destination: z.string().optional(), // egress 时必填
  description: z.string().optional(),
});

const secgroupSchema = z.object({
  name: z.string().min(1),
  rules: z.array(secgroupRuleSchema).min(1),
});

const subnetSchema = z.object({
  name: z.string().min(1),
  cidr,
  az,
  route_table: z.string().optional(),
});

const topologySchema = z.object({
  vpc: z.object({ name: z.string().min(1), cidr }),
  subnets: z.array(subnetSchema).min(1),
  route_tables: z.array(routeTableSchema).optional(),
  security_groups: z.array(secgroupSchema).min(1),
});

const eipAttachSchema = z.object({
  kind: z.enum(["instance", "port", "nat"]),
  target: z.string().min(1),
});

const eipSchema = z.object({
  id: z.string().min(1),
  bandwidth: z.string().min(1),
  attached_to: eipAttachSchema,
});

const natSchema = z.object({
  id: z.string().min(1),
  subnet: z.string().min(1),
  snat_eip: z.string().min(1),
  snat_source_cidr: z.string().min(1),
});

const listenerSchema = z.object({
  port: z.number().int().min(1).max(65535),
  protocol: z.enum(["http", "https", "tcp", "udp"]),
});

const memberSchema = z.object({
  target: z.string().min(1), // references components[].id
  port: z.number().int().min(1).max(65535),
});

const loadbalancerSchema = z.object({
  id: z.string().min(1),
  subnet: z.string().min(1),
  vip_type: z.enum(["internal", "external"]),
  listeners: z.array(listenerSchema).min(1),
  members: z.array(memberSchema).min(1),
});

const networkObjectsSchema = z.object({
  eips: z.array(eipSchema).optional(),
  nat_gateways: z.array(natSchema).optional(),
  loadbalancers: z.array(loadbalancerSchema).optional(),
});

const componentSchema = z.object({
  id: z.string().min(1),
  type: z.string().regex(/^huaweicloud_/, "type must start with huaweicloud_"),
  subnet: z.string().optional(),
  security_groups: z.array(z.string()).optional(),
  instance: z.string().optional(), // only for compute_interface_attach
});

export const NetworkingSchema = z
  .object({
    $schema: z.string().optional(),
    topology: topologySchema,
    network_objects: networkObjectsSchema.optional(),
    components: z.array(componentSchema).min(1),
  })
  .superRefine((data, ctx) => {
    // A层引用一致性校验 (§6) — the server truly uses these.
    validateReferences(data, ctx);
  });

/** Collect names for uniqueness + reference checks. */
interface Refs {
  subnetNames: Set<string>;
  secgroupNames: Set<string>;
  routeTableNames: Set<string>;
  eipIds: Set<string>;
  natIds: Set<string>;
  componentIds: Set<string>;
}

function indexRefs(data: z.infer<typeof NetworkingSchema>): Refs {
  const refs: Refs = {
    subnetNames: new Set(),
    secgroupNames: new Set(),
    routeTableNames: new Set(),
    eipIds: new Set(),
    natIds: new Set(),
    componentIds: new Set(),
  };
  for (const s of data.topology.subnets) refs.subnetNames.add(s.name);
  for (const sg of data.topology.security_groups) refs.secgroupNames.add(sg.name);
  for (const rt of data.topology.route_tables ?? []) refs.routeTableNames.add(rt.name);
  for (const e of data.network_objects?.eips ?? []) refs.eipIds.add(e.id);
  for (const n of data.network_objects?.nat_gateways ?? []) refs.natIds.add(n.id);
  for (const c of data.components) refs.componentIds.add(c.id);
  return refs;
}

function validateReferences(data: z.infer<typeof NetworkingSchema>, ctx: z.RefinementCtx): void {
  const refs = indexRefs(data);

  // subnet name uniqueness
  const seenSubnets = new Set<string>();
  for (const s of data.topology.subnets) {
    if (seenSubnets.has(s.name)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `duplicate subnet name: ${s.name}`, path: ["topology", "subnets"] });
    }
    seenSubnets.add(s.name);
    if (s.route_table && !refs.routeTableNames.has(s.route_table)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `subnet ${s.name} references unknown route_table: ${s.route_table}`, path: ["topology", "subnets"] });
    }
  }

  // secgroup name uniqueness
  const seenSg = new Set<string>();
  for (const sg of data.topology.security_groups) {
    if (seenSg.has(sg.name)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `duplicate security_group name: ${sg.name}`, path: ["topology", "security_groups"] });
    }
    seenSg.add(sg.name);
    // ingress rules must have source, egress must have destination
    for (const [i, rule] of sg.rules.entries()) {
      if (rule.direction === "ingress" && !rule.source) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `ingress rule in ${sg.name} missing source`, path: ["topology", "security_groups", i, "rules"] });
      }
      if (rule.direction === "egress" && !rule.destination) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `egress rule in ${sg.name} missing destination`, path: ["topology", "security_groups", i, "rules"] });
      }
    }
  }

  // eip attached_to.target references
  for (const [i, e] of (data.network_objects?.eips ?? []).entries()) {
    if (e.attached_to.kind === "instance" || e.attached_to.kind === "port") {
      if (!refs.componentIds.has(e.attached_to.target)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `eip ${e.id} attached_to.target references unknown component: ${e.attached_to.target}`, path: ["network_objects", "eips", i] });
      }
    } else if (e.attached_to.kind === "nat") {
      if (!refs.natIds.has(e.attached_to.target)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `eip ${e.id} attached_to.target references unknown nat_gateway: ${e.attached_to.target}`, path: ["network_objects", "eips", i] });
      }
    }
  }

  // nat.snat_eip references eip id
  for (const [i, n] of (data.network_objects?.nat_gateways ?? []).entries()) {
    if (!refs.eipIds.has(n.snat_eip)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `nat ${n.id} snat_eip references unknown eip: ${n.snat_eip}`, path: ["network_objects", "nat_gateways", i] });
    }
    if (!refs.subnetNames.has(n.subnet)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `nat ${n.id} subnet references unknown subnet: ${n.subnet}`, path: ["network_objects", "nat_gateways", i] });
    }
  }

  // loadbalancer.subnet + members[].target references
  for (const [i, lb] of (data.network_objects?.loadbalancers ?? []).entries()) {
    if (!refs.subnetNames.has(lb.subnet)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `lb ${lb.id} subnet references unknown subnet: ${lb.subnet}`, path: ["network_objects", "loadbalancers", i] });
    }
    for (const [j, m] of lb.members.entries()) {
      if (!refs.componentIds.has(m.target)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `lb ${lb.id} member target references unknown component: ${m.target}`, path: ["network_objects", "loadbalancers", i, "members", j] });
      }
    }
  }

  // components: id uniqueness, subnet/sg references
  const seenComp = new Set<string>();
  for (const [i, c] of data.components.entries()) {
    if (seenComp.has(c.id)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `duplicate component id: ${c.id}`, path: ["components", i] });
    }
    seenComp.add(c.id);
    if (c.subnet && !refs.subnetNames.has(c.subnet)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `component ${c.id} subnet references unknown subnet: ${c.subnet}`, path: ["components", i] });
    }
    for (const sg of c.security_groups ?? []) {
      if (!refs.secgroupNames.has(sg)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `component ${c.id} references unknown security_group: ${sg}`, path: ["components", i] });
      }
    }
    if (c.type === "huaweicloud_compute_interface_attach" && !c.instance) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `compute_interface_attach ${c.id} missing instance (host ECS)`, path: ["components", i] });
    }
  }
}

export type Networking = z.infer<typeof NetworkingSchema>;
