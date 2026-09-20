# cost.json 设计 — 详细文档

> **关联**：主设计文档 §4.2 引用本文；本文是 cost.json schema 的完整推导和规范
> **目的**：记录 cost.json 的定位、时序、推导过程、事实依据，避免后续遗忘

---

## 1. cost.json 的定位

cost.json 是 **LLM 在写 .tf 之前产出的"规格+计费+价格"设计记录**。它不是 .tf 的派生摘要，而是**指导 .tf 编写的输入**。

两个作用：
1. **给 server 一个信号**：LLM 已经算过费用了（apply 前的"已估价"门，靠存在性 + tf_hash）
2. **给 LLM 一个记忆**：之前算的价格是什么（用户改了规格回退重算时，LLM 能看到上次的价格作参考）

### 1.1 跟 networking.json 的关系

| | networking.json | cost.json |
|---|---|---|
| 产出阶段 | 组网设计 | 规格计费设计（组网之后） |
| 内容 | 拓扑 + 组件清单 + 连接关系 | 每个组件的规格 + 计费 + 价格 + 来源(reuse/new) |
| 粒度 | 粗（只定有哪些网元） | 细（定具体 flavor、带宽、计费模式） |
| 组件引用 | components[].id | items[].resource 引用 components[].id |

networking.json 定"有哪些组件"，cost.json 定"每个组件什么规格、怎么计费、多少钱、复用还是新买"。

---

## 2. 正常部署时序（关键）

这是 cost.json 设计的核心前提：

```
1. update_networking      → networking.json（粗粒度组网：有哪些网元 + 拓扑）
2. list_existing_resources → 盘点华为云上已有可复用资源
3. LLM 决策：每个组件 reuse 还是 new，new 的选规格 + 计费
4. openapi_request(BSS 价格 API) → 查 new 资源的真实价格
5. 用户 review（规格/计费/价格/复用决策）
6. update_cost            → cost.json（落盘规格+计费+价格+来源）
7. 写 .tf（按 cost.json + networking.json：reuse 用 data source，new 用 resource）
8. terraform_plan         → 看预览
9. terraform_apply        → server 校验 cost.json + tf_hash
```

**关键点**：cost.json 在 .tf **之前**。这决定了 tf_hash 逻辑（见 §4）。

### 2.1 为什么 cost.json 在 .tf 之前

- 用户在 apply 前要看到价格决策"值不值"——价格不能等 .tf 写完才有
- 规格和计费是 .tf 的输入参数，先定再写 .tf 自然
- 如果价格不行，用户回退改规格/计费，重算 cost.json——此时 .tf 还没写，回退成本低

### 2.2 资源来源：reuse vs new（关键设计）

**不是所有资源都新买**——用户云上可能已有资源可复用。

- **reuse**：复用已有资源。规格和计费**锁定**（跟着已有资源，LLM 不能改）。.tf 里用 `data` source 引用。cost.json 里 `monthly` 存已有资源当前月费（让用户知道复用资源本身花多少）。
- **new**：新买。LLM 选规格 + 计费。.tf 里用 `resource` 创建。cost.json 里 `monthly` 存 BSS 查到的新增月费。

**total_monthly 只算 new 的**——表示"这次部署新增月费"。reuse 的不计入 total（不是新增成本），但 item 里记着已有成本供参考。

---

## 3. 事实依据（来自华为云 provider 示例）

### 3.1 计费参数的两种 shape（穷举验证）

对所有带计费参数的资源类型（ECS/RDS/EVS/DCS/CSS/GeminiDB/TaurusDB/WAF/CCE/BMS/CBH/DEH/SFS Turbo/VPN/EIP/vpc_bandwidth/global_internet_bandwidth/cc_bandwidth_package）穷举：

**Shape A：包周期类**（几乎所有计算/数据库/存储实例）
```hcl
# ECS 示例（ecs/prepaid-instance/main.tf）
charging_mode = "prePaid"        # 或 "postPaid"（按需）
period_unit   = "month"          # month | year（仅 prePaid）
period        = 1                # 数字（仅 prePaid）
auto_renew    = true             # bool（仅 prePaid，可选）
```
适用：ECS、RDS、EVS、DCS、CSS、GeminiDB、TaurusDB、WAF cloud_instance、CCE node、BMS、CBH、DEH、SFS Turbo、VPN gateway 等。

**Shape B：带宽类**（EIP、共享带宽、全球带宽）
```hcl
# EIP bandwidth block 示例
bandwidth {
  charge_mode = "traffic"        # traffic | bandwidth（按流量 | 按带宽）
  share_type  = "PER"            # PER | WHOLE | STANDARD（独享 | 共享 | 标准）
  size        = 5                # Mbps
}
```
适用：huaweicloud_vpc_eip、huaweicloud_vpc_bandwidth、huaweicloud_global_internet_bandwidth。

**特例**：cc_bandwidth_package（云连接带宽包）同时有 `billing_mode = "prepaid"` + `charge_mode`——带宽类叠加包周期。罕见，cost.json 的 `charging` 对象允许同时带两组字段容纳。

**没有第三种 shape**。两个字段名注意区分：
- `charging_mode`（带 ing）：prePaid/postPaid（包周期维度）
- `charge_mode`（不带 ing）：traffic/bandwidth（带宽维度）

### 3.2 EIP share_type 影响价格

- `PER`：独享带宽，每个 EIP 独占带宽资源
- `WHOLE`：共享带宽，多个 EIP 共用一个 `huaweicloud_vpc_bandwidth` resource（EIP 引用 bandwidth.id）
- `STANDARD`：标准型

share_type 不同价格模型不同——cost.json 的带宽类 charging 要记 share_type。

### 3.3 reuse 资源在 .tf 里怎么引用

```hcl
# reuse 一个已有 ECS
data "huaweicloud_compute_instance" "web" {
  instance_id = "i-xxxx"        # cost.json 的 existing_id
}
# 后续资源引用 data.huaweicloud_compute_instance.web.xxx

# new 一个新 ECS
resource "huaweicloud_compute_instance" "db" {
  flavor_id      = "s6.large.2"
  charging_mode  = "prePaid"
  period         = 3
  period_unit    = "month"
  ...
}
```

### 3.4 BSS 价格 API

价格数据来自 BSS（计费服务）API，域名 `bss.cn-north-1.myhuaweicloud.com`（不分区域）。LLM 通过 `openapi_request("GET", ...)` 查按需/包周期价格。cost.json 只存最终价格数字，不存 BSS 原始响应。

---

## 4. tf_hash 逻辑（核心）

cost.json 在 .tf 之前，所以写入时算不了 .tf hash。采用"空则放行填、非空则校验"的状态机：

| cost.json 状态 | apply 行为 |
|---|---|
| 不存在 | 报错 "cost.json not found — call update_cost first" |
| tf_hash 为 null | 放行（第一次/上次失败），**apply 成功后**填当前 .tf hash |
| tf_hash 非空 | 重算当前 .tf hash 对比：匹配放行，不匹配报错 "tf_hash mismatch — .tf changed after cost estimate, re-run update_cost" |

### 4.1 为什么 apply 成功后才填 hash（不是 apply 前）

考虑回路：apply 失败 → 用户修 .tf bug 重试 → 如果 apply 前就填了 hash，修 .tf 后 hash 不匹配，要求重算 cost（但只修 bug 没改规格，无谓）。

**成功后填**：apply 失败不填 hash，下次仍当"第一次"放行，修 bug 重试不要求重算 cost。只有 apply 成功后，hash 才固化——之后改 .tf 必须重算 cost。

### 4.2 第一次 apply 的校验强度（诚实说明）

第一次 apply 时 hash 为 null 就放行——server **不校验".tf 是否真按 cost.json 的规格/计费写的"**。比如 cost.json 说 s6.large.2，LLM 写 .tf 写成 s6.medium.2，第一次 apply 不校验直接放行。

这靠：
- LLM 翻译正确（按 cost.json 写 .tf）
- plan 阶段用户 review（plan 输出会显示真实规格）

server 不做 HCL 语义校验（前面定的原则：需 AI/HCL 解析的不做）。第一次后的改 .tf 由 hash 门抓住。

### 4.3 tf_hash 计算方式

```
1. 列出 <dir>/ 下所有 *.tf 文件
2. 按文件名排序
3. 对每个文件内容取 SHA256
4. 拼接: "sha256:" + SHA256(文件名1 + hash1 + 文件名2 + hash2 + ...)
```

---

## 5. 完整 Schema

### 5.1 示例

```json
{
  "$schema": "huaweicloud-ops-deploy/cost/v1",
  "currency": "CNY",
  "items": [
    {
      "resource": "web",
      "source": "reuse",
      "existing_id": "i-xxxx",
      "spec": "s6.large.2 / 40GB SSD / cn-north-4a",
      "charging": { "mode": "prepaid", "period": 3, "period_unit": "month" },
      "monthly": 45.60
    },
    {
      "resource": "db",
      "source": "new",
      "spec": "MySQL 8.0 / s6.large.2 / 100GB / cn-north-4b",
      "charging": { "mode": "on-demand" },
      "monthly": 78.30
    },
    {
      "resource": "eip-web",
      "source": "new",
      "spec": "5Mbps bandwidth",
      "charging": { "mode": "bandwidth", "share_type": "PER", "size": 5 },
      "monthly": 23.00
    }
  ],
  "total_monthly": 101.30,
  "tf_hash": null,
  "estimated_at": "2026-09-18T12:00:00Z"
}
```

注意：
- `web` 是 reuse（复用已有 ECS），monthly 45.60 是已有资源当前月费（供参考），不计入 total
- `db` 和 `eip-web` 是 new，monthly 计入 total（78.30 + 23.00 = 101.30）
- `tf_hash` 写入时为 null，apply 成功后填

### 5.2 字段规范

| 字段 | 类型 | 必填 | 校验层 | 说明 |
|---|---|---|---|---|
| `currency` | string | ✅ | B | `"CNY"` \| `"USD"` |
| `items[]` | array | ✅ | A | 至少 1 个 |
| `items[].resource` | string | ✅ | A | 引用 networking.json `components[].id` |
| `items[].source` | enum | ✅ | A | `"reuse"` \| `"new"` |
| `items[].existing_id` | string | reuse 必填 | A | reuse 时已有资源 id（.tf 用 data source 引用） |
| `items[].spec` | string | ✅ | C | 人类可读规格描述，非空即可 |
| `items[].charging` | object | ✅ | A | 计费方案，见 §5.3 |
| `items[].monthly` | number \| null | ✅ | C | reuse: 已有资源当前月费；new: BSS 查到的新增月费；null: 无法估价 |
| `total_monthly` | number \| null | server 写入 | — | **只算 source=new 的 item monthly 之和**；有 null 当 0；全 null 则 null |
| `tf_hash` | string \| null | server 写入 | — | 写入时 null，apply 成功后填（见 §4） |
| `estimated_at` | string | server 写入 | — | ISO 8601 时间戳 |

### 5.3 charging 字段（两种 shape）

**包周期类**（ECS/RDS/EVS/DCS/CSS/GeminiDB/TaurusDB/WAF cloud_instance/CCE node/BMS/CBH/DEH/SFS Turbo/VPN gateway 等）：
```json
"charging": {
  "mode": "prepaid" | "on-demand",
  "period": 3,              // mode=prepaid 必填
  "period_unit": "month",   // mode=prepaid 必填，"month" | "year"
  "auto_renew": true        // 可选，mode=prepaid 时
}
```

**带宽类**（EIP/vpc_bandwidth/global_internet_bandwidth）：
```json
"charging": {
  "mode": "bandwidth" | "traffic",
  "share_type": "PER" | "WHOLE" | "STANDARD",  // 可选
  "size": 5                                       // Mbps，可选
}
```

**特例**（cc_bandwidth_package 等带宽+包周期组合）：允许同时带两组字段。

`mode` 是判别字段，两类字段不重叠。server 不校验"charging 跟 .tf 一致"（HCL 语义，不做）——靠 LLM 翻译正确 + tf_hash 保证"改 .tf 必须重算 cost"。

**cost.json mode ↔ provider 参数值映射**（LLM 写 .tf 时按下表翻译）：

| cost.json `charging.mode` | provider `charging_mode` | 说明 |
|---|---|---|
| `prepaid` | `prePaid` | 包年包月（带 period/period_unit/auto_renew） |
| `on-demand` | `postPaid` | 按需 |
| `bandwidth`（EIP） | `charge_mode = "bandwidth"` | 按带宽计费 |
| `traffic`（EIP） | `charge_mode = "traffic"` | 按流量计费 |

注意命名差异：包周期用 camelCase（prePaid/postPaid），带宽用小写（bandwidth/traffic）。cost.json 统一用小写连字符（prepaid/on-demand），翻译时转 camelCase。

---

## 6. 校验严格性分层

- **A 层（server 硬校验）**：`items[].resource` 引用 networking.json components[].id；`source` 枚举；reuse 时 existing_id 必填；`charging` 结构合法。
- **B 层（结构合法性）**：currency 枚举。
- **C 层（宽松，给 LLM/用户看）**：spec 内容、monthly 数值、charging 的 period/size 具体值——server 不基于做决策。

**server 不校验**：
- charging 跟 .tf 是否一致（HCL 语义）
- monthly 是否真等于 BSS 查到的价（server 不知道 BSS 返回什么）
- reuse 的 spec/charging 是否真跟已有资源一致（要调 API 查，是 LLM 写入职责）
- 价格合理性（用户判断）

`total_monthly` 是 server 写入字段（自动求和 new 的 monthly），不校验 LLM 传值——server 覆盖。

---

## 7. LLM 翻译指引（cost.json → .tf）

### 7.1 reuse 资源

```
items[].{resource:"web", source:"reuse", existing_id:"i-xxxx"}
```
→
```hcl
data "huaweicloud_compute_instance" "web" {
  instance_id = "i-xxxx"
}
# 后续引用 data.huaweicloud_compute_instance.web.id 等
```
不同资源类型的 data source 名不同（`huaweicloud_compute_instance` / `huaweicloud_rds_instance` / `huaweicloud_vpc_eip` 等），LLM 按 resource 的 type（从 networking.json 查）选。

### 7.2 new 资源（包周期类）

```
items[].{resource:"db", source:"new", charging:{mode:"prepaid", period:3, period_unit:"month"}}
```
→
```hcl
resource "huaweicloud_rds_instance" "db" {
  charging_mode = "prePaid"
  period        = 3
  period_unit   = "month"
  auto_renew    = true      # 可选
  ...
}
```

on-demand 模式：
```hcl
resource "huaweicloud_compute_instance" "db" {
  charging_mode = "postPaid"
  ...
}
```

### 7.3 new 资源（带宽类 EIP）

```
items[].{resource:"eip-web", source:"new", charging:{mode:"bandwidth", share_type:"PER", size:5}}
```
→
```hcl
resource "huaweicloud_vpc_eip" "eip-web" {
  publicip { type = "5_bgp" }
  bandwidth {
    name        = "eip-web-bw"
    size        = 5
    share_type  = "PER"
    charge_mode = "bandwidth"
  }
}
```

share_type=WHOLE 时，EIP 引用共享 bandwidth resource：
```hcl
resource "huaweicloud_vpc_bandwidth" "shared" { name=...; size=5; charge_mode="bandwidth" }
resource "huaweicloud_vpc_eip" "eip-web" {
  bandwidth { share_type = "WHOLE"; id = huaweicloud_vpc_bandwidth.shared.id }
}
```

---

## 8. server 真实用途

server 对 cost.json 做的事：
1. **`update_cost` 写入时**：zod schema 校验结构 + A 层引用一致性（resource 引用 networking components）+ 自动算 total_monthly（只算 new）+ tf_hash 置 null + estimated_at 写时间戳
2. **`terraform_apply` 前**：① 文件存在 ② tf_hash 状态机校验（§4）③ 成功后填 hash

server **不做**：校验 charging 跟 .tf 一致、校验价格真实、校验 reuse 跟已有资源一致、价格合理性判断。

---

## 9. 跟其他文件的引用关系

```
networking.json (components[].id)
       ↑
       │ items[].resource 引用
       │
cost.json (items[].resource, items[].source, items[].charging)
       ↓
       │ 指导 .tf 编写（reuse→data source, new→resource, charging→参数）
       ↓
.tf 文件
       ↓
       │ apply 成功后 tf_hash 回填
       ↓
cost.json.tf_hash（固化）
```

---

## 10. 未覆盖/待定

- **list_existing_resources 工具**：盘点已有可复用资源，返回归一化清单（id/type/spec/charging/status/network）。内部调多个 openapi_request 聚合。是第 17 个工具，部署流程组网后必走。
- **reuse 资源的状态校验**：list_existing_resources 返回的 status（running/stopped 等）是否影响可复用性？server 不判断，LLM 决定（stopped 的 ECS 能不能复用看场景）。
- **已有资源跨 region**：reuse 资源可能不在默认 region——list_existing_resources 要支持按 region 查。
- **价格波动**：BSS 按需价格可能波动，cost.json 的 monthly 是查询时点价格，apply 时可能变了——server 不处理，标注 estimated_at 让用户知道时点。
