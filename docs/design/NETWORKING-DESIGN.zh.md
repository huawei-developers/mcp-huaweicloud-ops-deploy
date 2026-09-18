# networking.json 物理组网建模 — 详细设计

> **关联**：主设计文档 §4.1 引用本文；本文是 networking.json schema 的完整推导和规范
> **目的**：记录"为什么这么建模"的完整推理链和事实依据，避免后续遗忘

---

## 1. 为什么需要这份文档

networking.json 是 LLM 在写 .tf 之前产出的**组网设计文件**。它不是给用户写的——LLM 设计、LLM 写、LLM 读、LLM 画拓扑图给用户看。用户看的是图，不是 JSON。

因此建模的准则是：**准确反映华为云物理组网，让 LLM 能据此写出生产级 .tf**，而不是"用户友好"。玩具部署不需要精确建模，生产级部署需要。

这份文档记录建模的推导过程、每个决策的事实依据、以及最终 schema 规范。后续如果质疑某个字段为什么这么设计，查这份文档。

---

## 2. 建模推导过程

### 2.1 第一轮（错误）：以组件为网络主体

最初 schema 给每个组件挂 `subnet + security_groups`，EIP 用 `bindings`。

**问题**：把"组件"当网络主体，但物理上网元是通过网卡接入网络的。EIP 不绑"组件"，ELB 后端不是组件附属。建模失真。

### 2.2 第二轮（错误）：以 ENI 为中心

试图用"网卡为桥梁"统一所有网络关系：每个网元显式建 ENI，EIP/ELB 都绑 ENI-id。

**问题**（double check 发现）：
- 华为云 provider 里 `huaweicloud_networking_interface` **零使用**——主网卡是 ECS 创建时自带的（`network { uuid }` block），不是显式 resource
- EIP 绑定目标**不统一**：ECS 用 `instance_id`，RDS 用 `port_id`，NAT 用 SNAT rule——不是都绑 ENI
- ELB member 用 **IP 地址**（`address`），不是 ENI-id

强制每个网元显式建 ENI 跟 provider 实际用法不符。

### 2.3 第三轮（修正）：网元直接接入 + 独立网络对象 + 扩展网卡可选

基于 provider 事实修正：

- **主网卡**：网元直接挂 subnet+security_groups（贴合 ECS `network{uuid}`、RDS `subnet_id` 的 90% 用法）
- **扩展网卡**：作为独立 component 用 `huaweicloud_compute_interface_attach` 表达（生产级多网卡需求，provider 支持显式 resource）
- **EIP/ELB/NAT**：独立 network_objects，各自表达绑定关系，绑定目标带 `kind`（反映华为云 3 种 associate 路径）
- **ELB member**：设计阶段用组件引用（`target: <component-id>`），不写 IP（plan 阶段 IP 是 unknown）

---

## 3. 事实依据（来自华为云 provider 示例）

所有建模决策对照 `terraform-provider-huaweicloud` 示例验证：

### 3.1 网元接入网络

**ECS**（`huaweicloud_compute_instance`）：
```hcl
resource "huaweicloud_compute_instance" "test" {
  security_group_ids = [huaweicloud_networking_secgroup.test.id]
  network {
    uuid = huaweicloud_vpc_subnet.test.id      # 主网卡，隐式创建
  }
}
```
→ 主网卡通过 `network { uuid }` block 创建，无显式 ENI resource。`network[0].port` 是 computed 属性（可引用 port id）。

**RDS**（`huaweicloud_rds_instance`）：
```hcl
resource "huaweicloud_rds_instance" "test" {
  subnet_id         = huaweicloud_vpc_subnet.test.id
  security_group_id = huaweicloud_networking_secgroup.test.id
}
```
→ 直接挂 subnet_id + security_group_id，不经过 ENI。

### 3.2 EIP 绑定目标（3 种 associate 路径）

**ECS 绑 EIP**（`huaweicloud_compute_eip_associate`）：
```hcl
resource "huaweicloud_compute_eip_associate" "test" {
  instance_id = huaweicloud_compute_instance.test.id    # 绑实例
  public_ip   = huaweicloud_vpc_eip.test[0].address
}
```

**RDS 绑 EIP**（`huaweicloud_vpc_eip_associate`）：
```hcl
data "huaweicloud_networking_port" "test" {
  network_id = huaweicloud_vpc_subnet.test.id
  fixed_ip   = huaweicloud_rds_instance.test.fixed_ip    # RDS 的 computed fixed_ip
}
resource "huaweicloud_vpc_eip_associate" "test" {
  public_ip = huaweicloud_vpc_eip.test[0].address
  port_id   = data.huaweicloud_networking_port.test.id   # 绑 port
}
```

**TaurusDB 绑 EIP**（`huaweicloud_taurusdb_eip_associate`）：
```hcl
resource "huaweicloud_taurusdb_eip_associate" "test" {
  instance_id = huaweicloud_taurusdb_instance.test.id    # 绑实例
}
```

**NAT SNAT**（`huaweicloud_nat_snat_rule`）：
```hcl
resource "huaweicloud_nat_gateway" "test" {
  vpc_id    = huaweicloud_vpc.test.id
  subnet_id = huaweicloud_vpc_subnet.test.id
}
resource "huaweicloud_vpc_eip" "test" { ... }
resource "huaweicloud_nat_snat_rule" "test" {
  floating_ip_id = huaweicloud_vpc_eip.test.id           # EIP 给 NAT 做 SNAT 源
  subnet_id      = huaweicloud_vpc_subnet.test.id
}
```

**穷举结论**：EIP associate 共 **6 种 resource**，绑定目标分**四类**：
- `compute_eip_associate` / `taurusdb_eip_associate`：`instance_id`（绑实例）
- `vpc_eip_associate`：`port_id`（绑 port/网卡，RDS 用）
- `global_eip_associate`：`associate_instance { region, project_id, instance_type, instance_id }`（绑实例+跨 region 信息）
- `eip_bandwidth_associate`：`publicip_id` + `bandwidth_id`（EIP 关联到共享带宽资源，不是绑实例）
- `vpc_eipv3_associate`：`publicip_id` + `associate_instance_id`（IPv6 EIP 绑 ELB/LB）

加上 NAT 走 SNAT rule（不是 associate）。所以 EIP 的 `attached_to` 必须带 `kind` 区分。当前 schema 覆盖 `kind: instance | port | nat`（主流三种），global/bandwidth/eipv3 罕见，有需求时补（见 §9）。

### 3.3 ELB member 用 IP 地址

```hcl
resource "huaweicloud_elb_member" "test" {
  pool_id       = huaweicloud_elb_pool.test.id
  address       = huaweicloud_compute_instance.test.access_ip_v4   # IP 地址！
  protocol_port = var.member_protocol_port
  subnet_id     = huaweicloud_vpc_subnet.test.ipv4_subnet_id
}
```
共享型 `huaweicloud_lb_member` 也是 `address` + `subnet_id`。

**plan-time unknown 问题**：`access_ip_v4` 是 computed，apply 后才有值。`terraform show -json` 里表现为 `"after": { "address": null }, "after_unknown": { "address": true }`。所以设计阶段 networking.json 不能写死 IP，用组件引用 `target: <component-id>`，LLM 翻译成 `address = huaweicloud_compute_instance.<id>.access_ip_v4`。

### 3.4 ELB loadbalancer 网络接入

```hcl
resource "huaweicloud_elb_loadbalancer" "test" {
  vpc_id          = huaweicloud_vpc.test.id
  ipv4_subnet_id  = huaweicloud_vpc_subnet.test.ipv4_subnet_id
  ipv6_network_id = huaweicloud_vpc_subnet.test.id          # 双栈：v4 + v6 两个 subnet
  availability_zone = ["cn-north-4a"]
}
```
→ ELB 自己挂 subnet（v4 + 可选 v6），是独立网络对象。

### 3.5 扩展网卡（显式 ENI）

```hcl
resource "huaweicloud_compute_interface_attach" "test" {
  instance_id       = huaweicloud_compute_instance.test.id   # 宿主 ECS
  network_id        = huaweicloud_vpc_subnet.test[1].id       # 第二个子网
  fixed_ip          = var.attached_interface_fixed_ip
  security_group_ids = var.attached_security_group_ids
}
```
→ 生产级多网卡场景（业务网 + 管理网）用这个 resource 显式创建扩展网卡。主网卡不需要。

### 3.6 纯逻辑资源（不入网）

- WAF dedicated_domain：引用 `policy_id`，自己无网络参数
- ELB listener：引用 `loadbalancer_id`，无网络位置
- ELB pool/monitor：引用 listener，纯逻辑
- WAF policy：纯配置

→ 这些资源只在 components 里记 `id + type`（给 cost 引用），不碰 network_objects，不挂 subnet。

### 3.7 主网卡不暴露 fixed_ip/port_id

ECS `network { uuid }` block 只接受 subnet uuid，不暴露 `fixed_ip` / `port_id`。主网卡是隐式的。port id 只能通过 computed 属性 `huaweicloud_compute_instance.test.network[0].port` 引用拿到（VPCE service 示例就这么用）。

---

## 4. 最终 Schema

### 4.1 结构总览

```
networking.json
├── topology              网络基础设施
│   ├── vpc               大网
│   ├── subnets           地址段 + AZ + 路由表引用
│   ├── route_tables      路由（下一跳到 NAT/VPN/对等连接）
│   └── security_groups   规则集合
│
├── network_objects       独立网络对象（有网络位置和连接关系）
│   ├── eips              公网出口
│   ├── nat_gateways      子网级出站网关
│   └── loadbalancers     入站入口
│
└── components            资源清单（纯身份 + 可选网络接入）
    ├── 网元类            id + type + subnet + security_groups（主网卡）
    ├── 扩展网卡类        id + type=huaweicloud_compute_interface_attach + instance + subnet + security_groups
    └── 纯逻辑类          id + type（WAF policy、ELB listener/pool 等）
```

### 4.2 完整示例

```json
{
  "$schema": "huaweicloud-ops-deploy/networking/v1",
  "topology": {
    "vpc": { "name": "vpc-main", "cidr": "192.168.0.0/16" },
    "subnets": [
      { "name": "subnet-web", "cidr": "192.168.1.0/24", "az": "cn-north-4a", "route_table": "rt-web" },
      { "name": "subnet-db",  "cidr": "192.168.2.0/24", "az": "cn-north-4b", "route_table": "rt-db" },
      { "name": "subnet-mgmt", "cidr": "192.168.3.0/24", "az": "cn-north-4a", "route_table": "rt-web" }
    ],
    "route_tables": [
      { "name": "rt-web", "routes": [
        { "destination": "0.0.0.0/0", "next_hop_type": "nat", "next_hop": "nat-web" }
      ]},
      { "name": "rt-db", "routes": [] }
    ],
    "security_groups": [
      { "name": "web-sg", "rules": [
        { "direction": "ingress", "protocol": "tcp", "ports": "443", "source": "0.0.0.0/0", "description": "HTTPS" },
        { "direction": "ingress", "protocol": "tcp", "ports": "22",  "source": "<user-ip>/32", "description": "SSH" },
        { "direction": "egress",  "protocol": "tcp", "ports": "3306", "destination": "192.168.2.0/24", "description": "web → db" }
      ]},
      { "name": "db-sg", "rules": [
        { "direction": "ingress", "protocol": "tcp", "ports": "3306", "source": "192.168.1.0/24", "description": "only from web subnet" }
      ]},
      { "name": "mgmt-sg", "rules": [
        { "direction": "ingress", "protocol": "tcp", "ports": "22", "source": "192.168.3.0/24", "description": "mgmt" }
      ]}
    ]
  },
  "network_objects": {
    "eips": [
      { "id": "eip-web", "bandwidth": "5Mbps",
        "attached_to": { "kind": "instance", "target": "web" } },
      { "id": "eip-nat", "bandwidth": "10Mbps",
        "attached_to": { "kind": "nat", "target": "nat-web" } }
    ],
    "nat_gateways": [
      { "id": "nat-web", "subnet": "subnet-web", "snat_eip": "eip-nat",
        "snat_source_cidr": "192.168.1.0/24" }
    ],
    "loadbalancers": [
      { "id": "elb-web", "subnet": "subnet-web", "vip_type": "external",
        "listeners": [
          { "port": 443, "protocol": "https" }
        ],
        "members": [
          { "target": "web", "port": 8080 }
        ] }
    ]
  },
  "components": [
    { "id": "web", "type": "huaweicloud_compute_instance",
      "subnet": "subnet-web", "security_groups": ["web-sg"] },
    { "id": "web-mgmt-nic", "type": "huaweicloud_compute_interface_attach",
      "instance": "web", "subnet": "subnet-mgmt", "security_groups": ["mgmt-sg"] },
    { "id": "db", "type": "huaweicloud_rds_instance",
      "subnet": "subnet-db", "security_groups": ["db-sg"] },
    { "id": "elb-web", "type": "huaweicloud_elb_loadbalancer" },
    { "id": "elb-web-listener", "type": "huaweicloud_elb_listener" },
    { "id": "elb-web-pool", "type": "huaweicloud_elb_pool" },
    { "id": "waf-policy", "type": "huaweicloud_waf_policy" },
    { "id": "waf-domain", "type": "huaweicloud_waf_dedicated_domain" }
  ]
}
```

注意：
- `elb-web` 在 components（身份，给 cost 引用）和 network_objects.loadbalancers（网络语义）里都出现，id 关联——ELB 的双重身份
- `web-mgmt-nic` 是扩展网卡，独立 component，`instance: "web"` 引用宿主
- `elb-web-listener` / `elb-web-pool` / `waf-policy` / `waf-domain` 是纯逻辑资源，只有 id+type

---

## 5. 字段规范

### 5.1 topology 层

| 字段 | 类型 | 必填 | 校验层 | 说明 |
|---|---|---|---|---|
| `topology.vpc.name` | string | ✅ | A | 非空 |
| `topology.vpc.cidr` | string | ✅ | A | 合法 CIDR |
| `topology.subnets[]` | array | ✅ | A | 至少 1 个 |
| `topology.subnets[].name` | string | ✅ | A | topology 内唯一 |
| `topology.subnets[].cidr` | string | ✅ | A | 合法 CIDR，是 vpc.cidr 子集 |
| `topology.subnets[].az` | string | ✅ | A | 非空 |
| `topology.subnets[].route_table` | string | 可选 | A | 若给则引用 route_tables[].name |
| `topology.route_tables[]` | array | 可选 | A | 有 subnet 引用时必须存在 |
| `topology.route_tables[].name` | string | ✅ | A | topology 内唯一 |
| `topology.route_tables[].routes[]` | array | ✅ | B | 至少 1 个（可为空数组表示默认路由） |
| `routes[].destination` | string | ✅ | A | 合法 CIDR |
| `routes[].next_hop_type` | enum | ✅ | B | `nat` \| `vpn` \| `peering` \| `internet`（`internet` = 直连公网，如子网自带公网出口/SNAT 直连；`nat` = 走 NAT 网关；`vpn`/`peering` 预留） |
| `routes[].next_hop` | string | ✅ | A | 引用对应类型的 network_object id 或外部标识 |
| `topology.security_groups[]` | array | ✅ | A | 至少 1 个 |
| `topology.security_groups[].name` | string | ✅ | A | topology 内唯一 |
| `topology.security_groups[].rules[]` | array | ✅ | B | 至少 1 个 |
| `rules[].direction` | enum | ✅ | B | `ingress` \| `egress` |
| `rules[].protocol` | enum | ✅ | B | `tcp` \| `udp` \| `icmp` \| `any` |
| `rules[].ports` | string | ✅ | C | 端口表示，字符串即可（server 不校验语法） |
| `rules[].source` | string | ingress 必填 | C | 非空字符串 |
| `rules[].destination` | string | egress 必填 | C | 非空字符串 |
| `rules[].description` | string | 可选 | C | — |

### 5.2 network_objects 层

| 字段 | 类型 | 必填 | 校验层 | 说明 |
|---|---|---|---|---|
| `network_objects.eips[]` | array | 可选 | A | — |
| `eips[].id` | string | ✅ | A | network_objects 内唯一 |
| `eips[].bandwidth` | string | ✅ | C | 带宽描述（"5Mbps" 等） |
| `eips[].attached_to.kind` | enum | ✅ | A | `instance` \| `port` \| `nat` |
| `eips[].attached_to.target` | string | ✅ | A | kind=instance/port→引用 components[].id；kind=nat→引用 nat_gateways[].id |
| `network_objects.nat_gateways[]` | array | 可选 | A | — |
| `nat_gateways[].id` | string | ✅ | A | 唯一 |
| `nat_gateways[].subnet` | string | ✅ | A | 引用 topology.subnets[].name |
| `nat_gateways[].snat_eip` | string | ✅ | A | 引用 eips[].id |
| `nat_gateways[].snat_source_cidr` | string | ✅ | C | SNAT 源 CIDR |
| `network_objects.loadbalancers[]` | array | 可选 | A | — |
| `loadbalancers[].id` | string | ✅ | A | 唯一，且应在 components[].id 中存在（双重身份） |
| `loadbalancers[].subnet` | string | ✅ | A | 引用 topology.subnets[].name |
| `loadbalancers[].vip_type` | enum | ✅ | B | `internal` \| `external` |
| `loadbalancers[].listeners[]` | array | ✅ | B | 至少 1 个 |
| `listeners[].port` | number | ✅ | B | 1-65535 |
| `listeners[].protocol` | enum | ✅ | B | `http` \| `https` \| `tcp` \| `udp` |
| `loadbalancers[].members[]` | array | ✅ | B | 至少 1 个 |
| `members[].target` | string | ✅ | A | 引用 components[].id（设计阶段引用，apply 后才有真实 IP） |
| `members[].port` | number | ✅ | B | 1-65535 |

### 5.3 components 层

| 字段 | 类型 | 必填 | 校验层 | 说明 |
|---|---|---|---|---|
| `components[]` | array | ✅ | A | 至少 1 个 |
| `components[].id` | string | ✅ | A | 唯一（cost 引用一致性靠它） |
| `components[].type` | string | ✅ | A | 以 `huaweicloud_` 开头 |
| `components[].subnet` | string | 可选 | A | 若给则引用 topology.subnets[].name |
| `components[].security_groups[]` | string[] | 可选 | A | 若给则每个引用 topology.security_groups[].name |
| `components[].instance` | string | 仅扩展网卡必填 | A | type=huaweicloud_compute_interface_attach 时引用 components[].id（宿主 ECS） |

**字段可选性逻辑**：
- 网元类（ECS、RDS、WAF instance、ELB loadbalancer）：给 `subnet` + `security_groups`
- 扩展网卡类（`huaweicloud_compute_interface_attach`）：给 `instance` + `subnet` + `security_groups`
- 纯逻辑类（WAF policy/domain、ELB listener/pool/monitor）：只给 `id` + `type`
- server **不校验"某 type 该不该有 subnet"**——那需要 provider 知识（AI 判断），超出 server 工程化能力。server 只校验"给了 subnet 就必须引用合法 subnet name"

---

## 6. 校验严格性分层

server 校验契约来自 server 代码内硬编码的 zod schema（不是从文件 `$schema` 字段读的）。

- **A 层（server 硬校验）**：引用一致性、唯一性、CIDR 合法性。server 真用这些（update_networking 写入时校验 + cost 引用一致性 + apply 前存在性门）。
- **B 层（结构合法性）**：枚举值、必填、端口范围。zod 校验防 LLM 写出结构性垃圾。
- **C 层（给人/LLM 看，宽松）**：`ports` 语法、`source` 是否真合法 CIDR、`bandwidth` 值、`description`。server 不基于这些字段做决策，只要求字符串非空。

`$schema` 字段当前只是标识，不参与校验路由。文件是 server 跟 client LLM 之间的请求体，不是持久契约——server 升级不保证兼容旧文件，用户重跑 `update_networking` 即可。

---

## 7. LLM 翻译指引（networking.json → .tf）

LLM 写 .tf 时，把 networking.json 的抽象关系翻译成具体 provider resource：

### 7.1 网元主网卡

```
components[].{id:"web", subnet:"subnet-web", security_groups:["web-sg"]}
```
→
```hcl
resource "huaweicloud_compute_instance" "web" {
  security_group_ids = [huaweicloud_networking_secgroup.web-sg.id]
  network { uuid = huaweicloud_vpc_subnet.subnet-web.id }
}
```

### 7.2 扩展网卡

```
components[].{id:"web-mgmt-nic", type:"huaweicloud_compute_interface_attach",
              instance:"web", subnet:"subnet-mgmt", security_groups:["mgmt-sg"]}
```
→
```hcl
resource "huaweicloud_compute_interface_attach" "web-mgmt-nic" {
  instance_id        = huaweicloud_compute_instance.web.id
  network_id         = huaweicloud_vpc_subnet.subnet-mgmt.id
  security_group_ids = [huaweicloud_networking_secgroup.mgmt-sg.id]
}
```

### 7.3 EIP（按 kind 选 associate resource）

```
eips[].{id:"eip-web", attached_to:{kind:"instance", target:"web"}}
```
→
```hcl
resource "huaweicloud_vpc_eip" "eip-web" { publicip {...} bandwidth {...} }
resource "huaweicloud_compute_eip_associate" "eip-web" {
  instance_id = huaweicloud_compute_instance.web.id
  public_ip   = huaweicloud_vpc_eip.eip-web.address
}
```

`kind=port`（RDS）→ 用 `huaweicloud_vpc_eip_associate` + `data.huaweicloud_networking_port`（按 target 组件的 fixed_ip 查 port）。
`kind=nat` → 不建 associate，EIP 作为 NAT 的 `snat_eip`，在 NAT SNAT rule 里引用。

### 7.4 ELB member（target → address 引用）

```
loadbalancers[].members[].{target:"web", port:8080}
```
→
```hcl
resource "huaweicloud_elb_member" "web" {
  pool_id       = huaweicloud_elb_pool.<pool>.id
  address       = huaweicloud_compute_instance.web.access_ip_v4   # computed, apply 后才有
  protocol_port = 8080
  subnet_id     = huaweicloud_vpc_subnet.<subnet>.id
}
```

LLM 需推断 member 的 `subnet_id`。**规则**：用 member.target 指向的 component（如 web）的 subnet——即后端 ECS 所在 subnet，不是 loadbalancer 的 subnet（后端可能跟 LB 跨 subnet）。如果后端 component 没声明 subnet（纯逻辑资源或跨 VPC），退化用 loadbalancer 的 subnet。

### 7.5 NAT gateway

```
nat_gateways[].{id:"nat-web", subnet:"subnet-web", snat_eip:"eip-nat", snat_source_cidr:"192.168.1.0/24"}
```
→
```hcl
resource "huaweicloud_nat_gateway" "nat-web" {
  vpc_id    = huaweicloud_vpc.<vpc>.id
  subnet_id = huaweicloud_vpc_subnet.subnet-web.id
}
resource "huaweicloud_nat_snat_rule" "nat-web" {
  nat_gateway_id = huaweicloud_nat_gateway.nat-web.id
  floating_ip_id = huaweicloud_vpc_eip.eip-nat.id
  subnet_id      = huaweicloud_vpc_subnet.subnet-web.id
}
```

### 7.6 纯逻辑资源

只引用父资源，无网络翻译：
```
{id:"elb-web-listener", type:"huaweicloud_elb_listener"} → 引用 loadbalancer id
{id:"waf-domain", type:"huaweicloud_waf_dedicated_domain"} → 引用 policy + instance
```
LLM 按 provider schema（`provider_schema` 工具查）写这些资源的引用参数。

### 7.7 安全组规则（source/destination → remote_ip_prefix）

provider 的 `huaweicloud_networking_secgroup_rule` 里，ingress 和 egress **都用同一个字段 `remote_ip_prefix`**（不像 networking.json 分 source/destination）。翻译时按 direction 映射：

```
topology.security_groups[].rules[].{direction:"ingress", source:"0.0.0.0/0"}
→
resource "huaweicloud_networking_secgroup_rule" "..." {
  direction         = "ingress"
  remote_ip_prefix  = "0.0.0.0/0"    # source → remote_ip_prefix
}

rules[].{direction:"egress", destination:"192.168.2.0/24"}
→
  direction         = "egress"
  remote_ip_prefix  = "192.168.2.0/24"   # destination → remote_ip_prefix
```

端口字段：provider 支持两种——`ports`（字符串如 "80,443"）或 `port_range_min`+`port_range_max`。networking.json 的 `ports` 字段（C 层宽松）按内容选：含逗号 → 用 `ports`；单端口 → 用 `ports` 或 `port_range_min=max=N`。

---

## 8. server 真实用途（为什么 schema 这么分层）

server 对 networking.json 只做这几件事：

1. **`update_networking` 写入时**：用 zod schema 校验结构 + A 层引用一致性（防 LLM 写出引用断裂的 JSON）
2. **`update_cost` 时**：读 `components[].id` 列表，校验 cost.json 的 `items[].resource` 引用合法
3. **`terraform_apply` 前**：检查文件存在（存在性门，§6.3 第 1 门）

server **不**做：
- 校验 .tf 是否符合 networking 设计（HCL 语义，需 AI）
- 安全组规则合理性判断（靠人 review）
- 资源类型是否真实存在（查 provider schema 是 LLM 的事，server 只校验 `huaweicloud_` 前缀）
- 版本迁移（文件是请求体不是持久契约）

所以 schema 的 A 层只覆盖 server 真读的字段（id 唯一性、引用一致性），B/C 层服务于"防结构性垃圾"和"给 LLM 画图"——严格性匹配用途，不一刀切。

---

## 9. 未覆盖/待定

- **ELB loadbalancer 双栈（v4+v6 subnet）**：当前 `subnet` 单值。生产双栈场景若常态，考虑放开为 `subnet_v4` + `subnet_v6`。YAGNI，先单值。
- **VPN/对等连接**：`route_tables[].routes[].next_hop_type` 预留了 `vpn` / `peering`，但 network_objects 没建模 VPN/peering 对象。有需求时补。
- **全球 EIP（global_eip_associate）**：有结构化 `associate_instance { region, project_id, instance_type, instance_id }` 块（eip/geip-ipv4-cross-region/main.tf 验证）——绑实例但带跨 region 信息。当前 `eips[].attached_to.kind` 没覆盖 global，有需求时补 `kind: "global"`（target 引用 component-id，instance_type/region 透传）。
- **EIP 关联共享带宽（eip_bandwidth_associate）**：`publicip_id` + `bandwidth_id`——EIP 关联到共享带宽资源（eip/eip-associate-shared-bandwidth/main.tf）。这是第 4 种绑定模式（EIP ↔ bandwidth，不是 EIP ↔ instance/port/nat）。当前 `eips[].attached_to.kind` 没覆盖，有需求时补 `kind: "bandwidth"`（target 引用 bandwidth 资源 id）。
- **IPv6 EIP（vpc_eipv3_associate）**：`publicip_id` + `associate_instance_id`（绑 ELB/LB loadbalancer）。罕见，有需求时补。
- **WAF dedicated instance 的双重身份**：它既是 component 又是网元（有 subnet+security_groups）。当前按网元类处理（components 里给 subnet+security_groups），够用。
