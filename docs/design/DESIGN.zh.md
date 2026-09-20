# huaweicloud-ops-deploy MCP Server — Design Document

> **Tech Stack**: TypeScript + @modelcontextprotocol/server@2.0.0 + vendored ext-tasks schema
> **Protocol**: SDK 协商 2025-11-25（LATEST）；tasks 走 `io.modelcontextprotocol/tasks` 扩展（vendor 进仓库，底层注册——见 §8.2）

---

## 1. 我们要做什么

### 1.1 产品

**huaweicloud-ops-deploy** 是一个 MCP server，让 AI 编程助手（Claude Code、Cursor、DSH、opencode 等）能够通过 MCP 协议部署、查询、运维华为云基础设施。

用户对 AI 助手说"在华为云 cn-north-4 给我部署一个 WordPress"、"查我这个月华为云账单"、"把我上次的部署销毁掉"——AI 助手通过本 server 提供的工具完成这些操作。

### 1.2 典型场景

**场景 A：部署一个云上应用**

用户说"帮我在华为云部署一个 WordPress，单机就行，预算每月 200 以内"。

AI 助手需要：查可用 ECS 规格、设计网络（VPC/子网/安全组）、跟用户确认组网、写 terraform 配置、跑 plan 预览、查真实价格、跟用户确认价格、执行 apply、拿到部署结果（ECS 公网 IP）。每一步都需要用户确认。

**场景 B：查询现有云资源或账单**

用户说"我华为云上有几台 ECS？"或"我这个月花了多少钱？"。

AI 助手需要：查华为云 API 定义、调对应对账/资源 API、把结果整理给用户。

**场景 C：销毁部署**

用户说"把我上次的 WordPress 部署销毁掉"。

AI 助手需要：跑 terraform destroy、确认资源清空、删掉部署目录。

### 1.3 面向的用户

- **最终用户**：华为云开发者/运维，通过 AI 助手操作云资源，不想手写 terraform 或点控制台
- **AI 助手（客户端 LLM）**：编排者，理解用户意图、设计架构、写 .tf、跟用户确认、调用本 server 的工具执行
- **本 server**：执行者，提供华为云认证、API 调用、terraform 执行等原子能力，不做业务判断

### 1.4 设计方案

针对上述场景，server 的设计回应：

**场景 A 的需求** → 提供部署目录管理（`create_deployment`）、组网设计落盘（`update_networking`）、本地 provider schema 提取（`provider_schema`，写 .tf 前查参数契约）、编排示例导出（`terraform_examples_export`）、terraform 执行（`terraform_init/plan/apply`）、价格估算落盘与 apply 前多门安全门校验（`update_cost` + `terraform_apply` 四门：networking 存在 + cost 存在 + tf_hash + 无明文凭证）

**场景 B 的需求** → 提供 API 定义查询（`apiexplorer`）和签名后的 API 调用（`openapi_request`）

**场景 C 的需求** → 提供 terraform 销毁执行（`terraform_destroy`）和目录清理（`delete_deployment`，资源未清空时拒绝）

**通用的凭证与数据需求** → 提供认证持久化（`auth`，存 OS keychain）和按云服务分类的 terraform 示例导出（`terraform_examples_export`，可迭代内容资产）

**安全 review 辅助** → plan/state 后从结构化输出提取安全组规则显性化返回（§6.4），把埋得深的信息提到表面给人 review

**长时操作的需求** → terraform install/init/plan/apply/destroy/refresh 都可能超客户端超时（下载、refresh、云操作），用 MCP tasks 扩展返回 task handle + 进度通知，避免客户端超时；task 状态纯内存（server 重启 = task 丢失，LLM 重新发起，terraform 幂等保底）

### 1.5 Server 的职责边界

Server 负责（工程化可判定的事项，做安全门校验）：
- 凭证管理与签名（AK/SK 不暴露给客户端）
- 华为云 OpenAPI 定义与 terraform 示例的数据导出
- 从本地已装 provider 提取 schema（参数契约）供 client LLM 写 .tf 参考
- 在指定目录执行 terraform 命令
- 部署状态文件（networking.json / cost.json）的 schema 校验与持久化
- 长时操作（apply/destroy/refresh）的 task 生命周期与进度通知
- apply 前的安全门校验：① cost.json 存在且 tf_hash 匹配 ② networking.json 存在 ③ .tf 无明文凭证

Server 不负责（需要理解/判断的事项，交给 client LLM 或人）：
- 架构设计（客户端 LLM 做）
- .tf 文件编写（客户端 LLM 做）
- 规格选择决策（客户端 LLM 做）
- .tf 是否符合 networking.json 设计意图（需 HCL 语义/AI 判断，server 不校验，靠人 review plan）
- 安全组规则合理性（靠人 review，server 只在 plan/state 后把规则显性化列出）
- 流程编排（客户端 LLM 做，server 只在 apply 时强制安全门）

### 1.6 与官方 terraform-mcp-server 的分工

HashiCorp 官方 `terraform-mcp-server` 覆盖**云无关的通用 Terraform 生态能力**：Terraform Registry 查询（`search_providers`/`get_provider_details`/`search_modules`/`get_module_details`）和 HCP Terraform/TFE 平台操作（workspace/run 管理）。它不跑本地 terraform，不碰具体云。

本 server 专注**华为云专属能力**，两者不重叠、可同时挂：
- 通用 Registry/TFE 查询 → 走官方 server（用户可选）
- 华为云 API 签名调用、本地 terraform 执行、华为云 provider schema 提取、华为云编排 examples → 走本 server

本 server 不重复实现官方已有的通用工具——避免外部 API 跟进负担、避免定位模糊。差异化在于：华为云专属知识（provider schema 本地提取、按云服务分类的编排 examples、BSS/价格 API、大陆备案要求等），这些是云无关的官方 server 给不了的。

---

## 2. 技术栈

### 2.1 运行时

- **Language**: TypeScript ≥ 7.0（Node.js ≥ 20）。TS ≥ 6.0 起不再自动包含 `@types/*`，tsconfig 需 `"types": ["node"]`
- **MCP SDK**: `@modelcontextprotocol/server@2.0.0`（v2 stable release line）。v2 拆分包架构，依赖 `@modelcontextprotocol/core` + `zod ^4.2.0`
- **协议版本**: SDK 的 `LATEST_PROTOCOL_VERSION = "2025-11-25"`，`SUPPORTED_PROTOCOL_VERSIONS = ["2025-11-25","2025-06-18","2025-03-26","2024-11-05","2024-10-07"]`——**不包含 2026-07-28**。2026-07-28 在 SDK 里是 "era" 概念（部分语义实现），不是 wire 协议版本号。SDK 通过 `server/discover` 广播支持的版本，跟客户端协商
- **Tasks 扩展**: `io.modelcontextprotocol/tasks`（基于 SEP-2663，规范在独立仓库 `modelcontextprotocol/ext-tasks`，`schema/2026-07-28/` 状态 **Stable**）。SDK 2.0.0 **不提供 task 运行时**——task 相关的 wire 类型（`TaskSchema`/`CreateTaskResultSchema`/`ServerTasksCapabilitySchema` 等）标 `@deprecated 2025-11-25 wire vocabulary with no SDK runtime; kept importable for interoperability only`，高层 `McpServer` 的 `RequestMethod` 显式 `Exclude<..., TaskRequestMethod>` 排除 task 方法。**但 `ServerCapabilitiesSchema` 的 `tasks` 字段存在（引用的子 schema 虽标 deprecated，但 `registerCapabilities` 运行时不校验、可声明），底层 `Protocol.setRequestHandler` 3 参数重载支持任意自定义 method**——我们通过引入 ext-tasks 的 Stable schema + 底层注册实现（见 §8.2）
- **传输**: stdio（默认，MCP 客户端作为父进程 spawn）。HTTP 传输走可选的框架适配器包（`@modelcontextprotocol/node` / `hono` / `express` / `fastify`），Phase 1 只做 stdio，HTTP 后置

> **v1 单体包 `@modelcontextprotocol/sdk` 已被 v2 取代**。v1 sdk 里 tasks 在 `experimental/` 下；v2 把 task wire 类型降级为 deprecated（因为是扩展不是核心 wire），但保留了 capability 声明和底层 method 注册口子——这比 v1 的 experimental 更适合我们落地。

### 2.2 依赖

| 依赖 | 用途 | 纯 JS？ |
|---|---|---|
| `@modelcontextprotocol/server` | MCP 协议 v2（协商 2025-11-25；ServerCapabilities 含 tasks 字段；底层 Protocol.setRequestHandler 支持自定义 method） | ✅ |
| vendored `ext-tasks` schema | `io.modelcontextprotocol/tasks` 2026-07-28 Stable schema（vendor 进仓库，不走 npm 依赖） | ✅ |
| `zod` ^4.2.0 | schema 校验（networking.json / cost.json / tool 参数） | ✅ |
| `@napi-rs/keyring` (keyring-rs Node binding, actively maintained; replaces deprecated keytar) | OS keychain 访问（macOS Keychain / Windows DPAPI / Linux Secret Service） | prebuilt binaries |
| `node-machine-id` | 机器指纹（keychain 不可用时 fallback） | ✅ |
| `crypto` (Node 内置) | SDK-HMAC-SHA256 签名 + AES-GCM 加密 | ✅ |
| `adm-zip` | zip 解压（terraform binary 下载 + terraform_examples_export） | ✅ |

### 2.3 为什么用 TS 不用 Go

- MCP TS SDK v2 是官方第一方 stable release line；tasks 扩展规范 Stable（ext-tasks 2026-07-28），SDK 不提供运行时但保留底层注册口子（§8.2）
- TS 生态的 keychain 库成熟（@napi-rs/keyring 活跃维护 (keyring-rs Node binding)）
- npm 分发天然适配（客户端 `npx` 直接跑，或 MCP client 配置指向）
- 跨平台不需要交叉编译

---

## 3. 工具集（17 个）

### 3.1 总览

```
部署目录管理（2）：
  create_deployment(deployment)
  delete_deployment(deployment)

部署状态文件（2）：
  update_networking(deployment, networking)
  update_cost(deployment, cost)

华为云能力（5）：
  auth()
  apiexplorer(productshort?, api_name?, regions?, endpoints?, limit?, offset?)
  openapi_request(method, url, body, headers)
  list_existing_resources(service?, region?, detail?, marker?)
  terraform_examples_export(dest)

Terraform 执行（8）：
  terraform_install()
  terraform_init(deployment)
  provider_schema(deployment, resource_type?)
  terraform_plan(deployment)
  terraform_apply(deployment)
  terraform_destroy(deployment)
  terraform_refresh(deployment)
  terraform_state(deployment)
```

### 3.2 工具详细定义

#### create_deployment

```
名称: create_deployment
描述: Create or reuse a deployment workspace directory. If the directory does
      not exist, create it and write .deployment.json (state snapshot, see §4.3)
      — records created_at, server_version, and current account if authenticated
      (auth can be done later; account field filled on first subsequent operation
      if empty). Does NOT create networking.json/cost.json placeholders — those
      are written by update_networking/update_cost.

      If the directory is an existing deployment (contains .deployment.json),
      return the existing deployment info + current status snapshot. If the
      directory exists but is not a deployment (non-empty, no .deployment.json),
      return an error — the client should pick an empty or deployment directory.
参数:
  deployment (string, required): Absolute or relative path to the deployment directory.
返回:
  成功: { "deployment": "...", "status": "created" | "existing",
          "snapshot": { account, status } }
  失败: { "error": "directory is not empty and not a deployment" }
```

#### delete_deployment

```
名称: delete_deployment
描述: Delete a deployment workspace directory. A deployment is identified by
      the presence of .deployment.json (see §4.3) — consistent with create_deployment.
      refuses if the deployment still has live cloud resources — check
      terraform.tfstate for non-empty resources; if resources exist, return an
      error telling the client to run terraform_destroy first. If no resources
      (never applied, or already destroyed), remove the directory.
参数:
  deployment (string, required): Path to the deployment directory.
返回:
  成功: { "deployment": "...", "status": "deleted" }
  失败: { "error": "deployment has N live resources — run terraform_destroy first" }
       { "error": "not a deployment directory (no .deployment.json)" }
```

#### update_networking

```
名称: update_networking
描述: Write or update the networking design file (networking.json) for a
      deployment. This file models the physical HuaweiCloud network topology
      (see §4.1 and NETWORKING-DESIGN.zh.md for full spec). Three layers:
        - topology: VPC, subnets, route_tables, security_groups (infra)
        - network_objects: eips / nat_gateways / loadbalancers (independent
          network objects with their own attachment semantics; EIP binding
          target carries `kind`: instance/port/nat)
        - components: resource list — network elements (subnet+security_groups,
          primary ENI implicit), extension ENIs (compute_interface_attach),
          and pure-logic resources (WAF policy, ELB listener/pool, id+type only)
      The client LLM designs this before writing .tf — it is the physical
      networking contract that .tf must implement. LLM also draws the topology
      diagram for the user from this file. Server validates structure + A-layer
      reference consistency (id uniqueness, subnet/sg/eip/nat/member refs) via
      zod; strictness tiered A/B/C by whether server actually uses the field.
参数:
  deployment (string, required): Deployment directory path.
  networking (object, required): Networking design, see schema §4.1.
返回:
  成功: { "file": "<deployment>/networking.json", "components": N, "subnets": M,
          "security_groups": K, "network_objects": L }
  失败: { "error": "schema validation: <details>" }
```

#### update_cost

```
名称: update_cost
描述: Write or update the cost estimate file (cost.json) for a deployment.
      This file is produced BEFORE writing .tf — it is the spec+billing+price
      design record that guides .tf authoring (not a .tf derivative). See §4.2
      and COST-DESIGN.zh.md for full spec.

      Each item declares: resource (ref to networking.json components[].id),
      source (reuse|new), spec, charging (two shapes: period-type for
      ECS/RDS/etc, bandwidth-type for EIP), monthly. Reuse items record the
      existing resource's current monthly cost; new items record the BSS-queried
      price. total_monthly is server-computed (sum of new items only).

      Server sets tf_hash = null on write (cost.json precedes .tf). terraform_apply
      fills tf_hash after successful apply (see §6.3 state machine). The client
      does not compute tf_hash or total_monthly.
参数:
  deployment (string, required): Deployment directory path.
  cost (object, required): Cost estimate, see schema §4.2 / COST-DESIGN.zh.md.
       Must include currency, items[] (each with resource/source/spec/charging/monthly).
返回:
  成功: { "file": "<deployment>/cost.json", "total_monthly": 123.45, "tf_hash": null,
          "items": N }
  失败: { "error": "schema validation: <details>" }
```

#### auth

```
名称: auth
描述: Authenticate with HuaweiCloud. Takes NO parameters — AK/SK/region are
      collected via MCP elicitation (client pops a form), so credentials never
      enter the LLM dialog context. Flow:
        1. LLM calls auth() (no args)
        2. server returns inputRequired with an elicitation form (AK/SK/region/
           optional security_token fields)
        3. client UI shows the form to the user (does NOT pass through LLM)
        4. user fills AK/SK → client retries tools/call with inputResponses
        5. server handler re-enters, reads AK/SK from inputResponses (NOT from
           tool args), validates against HuaweiCloud IAM, persists to keychain
        6. returns { authenticated, region, account } to LLM (LLM sees only the
           result, never the credential values)

      Verifies credentials via GET /v3/projects (signed). Persists to OS secure
      storage (macOS Keychain / Windows DPAPI / Linux Secret Service); keychain
      unavailable → machine-fingerprint-bound encrypted file fallback. STS
      (security_token) not persisted (expires). Subsequent tools read credentials
      automatically. Credentials scoped to current machine.

      Environment variable prefill: server reads HW_ACCESS_KEY / HW_SECRET_KEY /
      HW_SECURITY_TOKEN / HW_REGION_NAME (process.env, server-side) and uses them as
      `default` values in the elicitation form — user sees prefilled values and
      decides whether to use or override. env values don't enter LLM context,
      only the form defaults. If env vars fully cover credentials, user just
      confirms the form without retyping.

      Client prerequisite: must declare elicitation capability. If unsupported,
      falls back to env vars ONLY (not AK/SK tool args — that would leak
      credentials into LLM context, violating §5.1): server reads
      HW_ACCESS_KEY/HW_SECRET_KEY/HW_REGION_NAME directly. Missing env → error
      "configure env vars or use an elicitation-capable client". Invalid env
      → error. No elicitation and no env → cannot authenticate.
参数: (none — credentials via elicitation)
返回:
  成功: { "authenticated": true, "region": "cn-north-4", "account": "...",
          "credential_source": "keychain" | "machine-bound-file" | "session",
          "sts": false }
  需输入 (inputRequired): { resultType: "input_required",
          inputRequests: { credentials: <elicitation form> } }
  失败: { "error": "invalid credentials: <API error>" }
       { "error": "elicitation declined by user" }
```

**实现要点**（SDK 源码验证）：
- `inputRequired()` builder（createMcpHandler d.mts:1448）+ `inputRequired.elicit({ message, requestedSchema })` 构造表单
- `acceptedContent(ctx.mcpReq.inputResponses, key, schema)` 读回用户填值（d.mts:1459，有 schema 校验重载 :1472）
- **legacyShim 默认开**（d.mts:2957 "default-on legacy shim"）——2025-era 客户端（stdio 协商 2025-11-25）靠 shim 自动转老式 elicitation/create + handler 重入。**不要设 `inputRequired.legacyShim: false`**，否则 2025-era 连接 loud fail（d.mts:2959-2960）
- 客户端须声明 `elicitation` capability（ClientCapabilitiesSchema.elicitation，auth-CUe6YdwF.mjs:307）；不声明则 shim 按 family 拒绝
- 单轮 elicitation 够（AK/SK/region 一次收齐），不需要 `requestState`（多轮才用，且涉及 HMAC 完整性保护）

#### apiexplorer

```
名称: apiexplorer
描述: Discover HuaweiCloud API definitions via APIExplorer (the "API of APIs")
      — dynamic query, NOT a static archive export. Five recursive levels:

      1. No args → list all cloud services (productshort + name + api_count).
         The LLM learns productshort values here (e.g. "ECS", "VPC", "RDS").
         ~310 services; server strips to 5 fields/product (65KB raw → 28KB).
      2. productshort (no api_name) → list that service's APIs (name + summary).
         Paginated via limit/offset; has_more/next_offset in the response.
      3. productshort + api_name → the API's full swagger (paths/parameters/
         definitions) — the parameter contract for calling openapi_request.
      4. regions=true → regions where the service/API is available (region_id +
         project_id). Use before openapi_request to confirm region support.
      5. endpoints=true → per-region endpoint hosts for the service (domain_url).
         Use to construct the full API URL for openapi_request.

      A dedicated tool (not just openapi_request) because: ListApis needs
      server-handled pagination; ShowApi needs server-side stripping of metadata
      the LLM doesn't need. APIExplorer is a global service (one unified host
      apiexplorer.cn-north-4.myhuaweicloud.com) — signedHttp signs it (verified:
      all 5 endpoints return 200 with AK/SK). X-Language: zh-cn sent
      for Chinese service/region names (swagger-defined enum).
参数:
  productshort (string, optional): Service short name, e.g. "ECS"|"VPC"|"RDS".
       Omit to list all services (level 1).
  api_name (string, optional): API name within the service, e.g. ListCloudServers.
       Requires productshort (level 3).
  regions (boolean, optional): List regions where service/API is available.
       Requires productshort (level 4).
  endpoints (boolean, optional): List per-region endpoint hosts (domain_url).
       Requires productshort (level 5).
  limit (integer, optional): Page size for ListApis/ListGroups (default 50,
       max 100 per APIExplorer swagger).
  offset (integer, optional): Pagination offset for ListApis/ListGroups.
返回:
  成功 (level 1): { "products": [{ "group":"计算", "name":"弹性云服务器",
                  "productshort":"ECS", "api_count":131, "is_global":false }],
                  "count": 310 }
  成功 (level 2): { "productshort":"ecs", "apis":[{ "name":"...", "summary":"..." }],
                  "count": 50, "total": 131, "offset": 0,
                  "has_more": true, "next_offset": 50 }
  成功 (level 3): { "name":"ListCloudServers", "summary":"...", "host":"ecs...",
                  "base_path":"/", "paths":{...}, "parameters":{...}, "definitions":{...} }
  成功 (level 4): { "productshort":"ecs", "regions":[{ "name":"华南-广州",
                  "region_id":"cn-south-1", "has_permission":true, "project_id":"..." }],
                  "count": 33 }
  成功 (level 5): { "productshort":"ecs", "endpoints":[{ "region":"cn-north-4",
                  "host":"ecs.cn-north-4.myhuaweicloud.com" }], "count": 33 }
  失败: { "error": "api_name requires productshort — ..." | "APIExplorer ... failed (HTTP ...)" }
```

#### openapi_request

```
名称: openapi_request
描述: Send an HTTP request to a HuaweiCloud API endpoint with automatic
      SDK-HMAC-SHA256 signing. The server reads stored credentials (from auth)
      and signs the request — the client never handles AK/SK. Works for any
      HuaweiCloud service API (ECS, VPC, RDS, BSS, RMS, etc.).

      SAFETY: GET/list/show requests are safe. For POST/PUT/DELETE (create/
      modify/delete operations), the request IS executed, but the response
      includes a prominent warning: "Unless the user explicitly requests it,
      the agent should not proactively call POST/DELETE or other impactful APIs.
      Every such call must inform the user of the potential consequences."

      The client LLM should discover the correct URL, method, and parameters
      via the apiexplorer tool first, then call openapi_request to execute.
参数:
  method (enum, required): HTTP method — GET, POST, PUT, DELETE, PATCH, HEAD.
  url (string, required): Full URL, e.g.
        "https://ecs.cn-north-4.myhuaweicloud.com/v1/.../cloudservers/flavors"
  body (string, optional): Request body (JSON string) for POST/PUT.
  headers (object, optional): Additional headers (Content-Type defaults to
          application/json).
返回:
  成功: { "status": 200, "headers": {...}, "body": "..." }
  非只读: { "status": 201, "headers": {...}, "body": "...",
            "warning": "Unless the user explicitly requests it, the agent
             should not proactively call POST/DELETE or other impactful APIs.
             Every such call must inform the user of the potential consequences." }
  失败: { "error": "HTTP 401: ..." | "signing failed: ..." | "not authenticated — call auth first" }
```

#### list_existing_resources

```
名称: list_existing_resources
描述: List HuaweiCloud resources the user already owns (for reuse in a deployment)
      via RMS (Resource Management Service) — the unified inventory API that
      covers ALL services (ECS, RDS, EIP, VPC, ELB, ...) in one call, instead of
      querying each service's list API separately. Two-stage query:

      Stage 1 (default, no service/region/detail args): CollectAllResourcesSummary.
        Returns a lightweight grouped count: provider → type → region → count.
        Cross-region by default — the user sees where resources live before
        drilling in. Cheap call, small response.

      Stage 2 (service, region, or detail=true): ListAllResources. Returns the
        actual resource list (id/name/provider/type/region/status/properties).
        Service + region narrow the query. Use after the summary tells you
        which service/region to drill into — avoids pulling a large list blindly.

      Also returns balance_summary (BSS balances + coupons) for the full cost
      context at the reuse/budget decision point. Coupons are auto-prioritized
      by HuaweiCloud (coupon > cash coupon > balance) — no .tf config needed.

      Called AFTER update_networking (components known) and BEFORE deciding
      specs/billing for update_cost. Reuse eligibility is not decided here —
      that's a judgment call.

      RMS APIs verified: both accept AK/SK signing (despite swagger
      marking PkiTokenAuth). domain_id == account_id (from auth). RMS host is
      global (rms.myhuaweicloud.com, no region prefix), like BSS.
参数:
  service (string, optional): Filter by RMS provider in detail mode:
       "vpc"|"ecs"|"rds"|"elb"|... (RMS provider field). Client-side filter —
       RMS v1 has no provider-only query (the `type` param requires "provider.type"
       format like "vpc.securityGroups").
  region (string, optional): Filter by region in detail mode. If omitted,
       details span ALL regions (summary mode is always cross-region).
  detail (boolean, optional): Force detail mode (full resource list) even
       without service/region. Default: summary mode.
  limit (integer, optional): Page size in detail mode (default 100, max 200).
       Ignored in summary mode.
  marker (string, optional): Pagination cursor from a previous detail-mode
       response's next_marker. Fetches the next page. Detail mode is
       caller-paginated: the server returns one page + next_marker; the caller
       passes it back to continue. The server does NOT auto-paginate or
       truncate — the caller decides whether to keep paging.
返回:
  成功 (summary mode): {
    "mode": "summary",
    "providers": [
      { "provider":"vpc", "types":[
        { "type":"vpcs", "total":7, "regions":[{"region":"cn-north-4","count":5},...] },
        { "type":"securityGroups", "total":19, "regions":[...] } ] },
      { "provider":"ecs", "types":[{"type":"cloudservers","total":2,...}] } ],
    "total_resources": 35,
    "hint": "Pass service, region, or detail=true to list specific resources.",
    "balance_summary": {
      "balances": [
        { "account_type": 1, "account_type_name": "余额", "amount": 22.53, "currency": "CNY" },
        { "account_type": 5, "account_type_name": "奖励金", "amount": 5.00, "currency": "CNY" } ],
      "coupons": {
        "count": 2, "total_balance": 150.0,
        "items": [
          { "coupon_id":"CP-xxx", "coupon_type":1, "coupon_type_name":"代金券", "balance":80.0,
            "face_value":100.0, "coupon_usage":"ECS 通用",
            "plan_name":"新用户礼包", "expire_time":"2026-12-31T23:59:59Z",
            "coupon_version":2, "is_frozen":0 },
          { "coupon_id":"CP-yyy", "coupon_type":4, "coupon_type_name":"现金券", "balance":70.0,
            "face_value":100.0, "coupon_usage":"全产品",
            "plan_name":"活动赠送", "expire_time":"2026-10-01T23:59:59Z",
            "coupon_version":2, "is_frozen":0 } ] } } }
         # account_type: 1=余额 2=信用 5=奖励金 7=保证金
         # coupon_type: 1=代金券 2=折扣券 3=产品券 4=现金券
         # coupon_version: 1=老版本(一次性) 2=新版本(反复用)
         # balance_summary structure defined in balance_summary.ts (BalanceSummary)
  成功 (detail mode): {
    "mode": "detail",
    "resources": [
      { "id":"3ccd9191-...", "name":"elb-265a", "provider":"elb",
        "type":"loadbalancers", "region":"cn-north-4",
        "project_id":"...", "enterprise_project":"default",
        "status":"Succeeded", "created":"...", "updated":"...",
        "tags":{}, "properties":{ ... service-specific fields ... } } ],
    "count": 12,
    "region": "cn-north-4",
    "next_marker": "CAESJgok...",
    "has_more": true,
    "note": "pass next_marker as marker to fetch the next page",
    "balance_summary": { ... same structure as summary mode, see above ... } }
         # When has_more is false, next_marker is omitted.
         # service filter is client-side: a page may have fewer matching
         # resources than limit (mixed services). If has_more and few matches,
         # keep paging to collect all resources of the requested service.
         # properties is passed through raw — service-specific (ECS has
         # flavor/vpc/subnet, VPC has cidr, EIP has public_ip, etc.).
         # LLM reads properties to judge reuse eligibility.
  失败: { "error": "not authenticated — call auth first" }
       { "error": "RMS summary failed (HTTP <status>): ..." }
       { "error": "RMS list failed (HTTP <status>): ..." }
```

#### terraform_examples_export

```
名称: terraform_examples_export
描述: Export HuaweiCloud terraform provider examples (.tf reference files) to
      the specified directory. Examples are organized by cloud service category
      (ecs, vpc, rds, ...), aligned with the huaweicloud provider's service
      breakdown. They serve as CROSS-RESOURCE ASSEMBLY TEMPLATES — working
      configurations showing how multiple resources compose (e.g. VPC + subnet
      + security group + ECS), plus HuaweiCloud-specific practical conventions
      (AZ selection, billing params, which optional args are effectively
      required).

      The parameter reference for individual resources (arguments, types,
      required-ness) is NOT here — use provider_schema for that. Examples show
      "how to assemble", provider_schema shows "what parts exist".

      Current phase: bundles official terraform-provider-huaweicloud examples.
      Future server versions may replace/supplement with scenario-specific
      examples (e.g. wordpress-stack, rds-with-read-replica) — the content is
      an iterable asset versioned with the server, distributed via the §9 data
      package.

      Note: example providers.tf files may contain access_key/secret_key lines
      from upstream docs — IGNORE those lines (credentials are injected via
      environment variables, see §6.2; server also enforces this at apply via
      the §6.3 credential gate).
参数:
  dest (string, required): Target directory for terraform examples. Distinct
       from the deployment workspace — reference data extraction target.
返回:
  成功: { "dest": "...", "files": N, "categories": ["ecs", "vpc", "rds", ...] }
  失败: { "error": "cannot write to <dest>: <reason>" }
```

#### terraform_install

```
名称: terraform_install
描述: Ensure a terraform binary is available. Only installs the binary —
      provider plugins are pulled by terraform_init (terraform's native
      provider installation mechanism), not by this tool.

      Binary resolution priority (first match wins):
        1. terraform_path parameter — use directly
        2. PATH — `terraform version` succeeds
        3. ~/.huaweicloud-ops-deploy/bin/terraform-<ver> — a binary this
           tool previously downloaded (global cache, reused across deployments)
        4. Download from binary_mirrors (default: HuaweiCloud mirror), then
           official HashiCorp releases as fallback

      Download location: ~/.huaweicloud-ops-deploy/bin/ (HOME writable).
      If HOME is not writable (sandbox/container with read-only home), falls
      back to <deployment>/.terraform/bin/ — the deployment parameter exists
      for this fallback; in the common case (1-3 above) it is unused.

      Idempotent: if a suitable binary is already found (1-3), returns
      immediately. Long-running only on first download (~20MB binary;
      1-2min on slow/continental networks). Uses MCP tasks extension when
      downloading (see §8). No-op if already cached (sync).

      The binary_mirrors parameter is optional — defaults to a built-in
      HuaweiCloud mirror. Override when the default is unreachable or the
      user specifies a preferred mirror (e.g. Tencent/Aliyun for non-Huawei
      CDNs). The client LLM does NOT need to call a separate "list_mirrors"
      tool — the default works for HuaweiCloud deployments.

      debug=true sets TF_LOG=DEBUG for the `terraform version` probe (rarely
      needed; mostly for diagnosing PATH detection issues).
参数:
  deployment (string, required): Deployment directory — only used as the
       download fallback when HOME is not writable. In the common case
       (binary found via PATH or global cache) this is unused.
  terraform_path (string, optional): Explicit path to a terraform binary.
       Use when the user tells the LLM "my terraform is at /opt/.../terraform".
       Skips PATH search and download.
  binary_mirrors (string[], optional): Binary download mirror base URLs,
       tried in order. Default: ["https://releases.hashicorp.com/terraform/"].
       HuaweiCloud does NOT mirror the terraform binary (verified:
       mirrors.huaweicloud.com/terraform/ hosts only the provider registry);
       the only source is HashiCorp's official releases. Override with a
       known-good mirror when a continental CDN is available.
       Each mirror is probed as <mirror>/<ver>/terraform_<ver>_<os>_<arch>.zip.
       Version defaults to a pinned known-good version (1.9.5) when the
       user doesn't specify one — reproducible installs without a latest-probe.
  debug (boolean, optional): Set TF_LOG=DEBUG for the version probe.
返回:
  成功 (sync if found): { "terraform": "1.9.5", "path": "/usr/local/bin/terraform",
          "source": "parameter" | "path" | "global-cache" | "downloaded",
          "cached": true }
  成功 (task if downloading): { "resultType": "task", "taskId": "...", "status": "working" }
  task completed result: { "terraform": "1.9.5", "path": "...", "source": "downloaded", "cached": false }
  失败: { "error": "terraform not found and download failed: ..." }
```

> **为什么只装 binary,不装 provider**:provider 不是独立"安装"的——它是 `terraform init` 根据 `.tf` 里的 `required_providers` + `.terraformrc` 的 mirror 配置,从镜像源或 registry 拉到 `.terraform/providers/` 或 `TF_PLUGIN_CACHE_DIR`。`terraform_install` 时还没有 `.tf`,不知道要拉哪个 provider 版本。预热 provider(像 openagent-go 的 PrewarmProviderCache)只能拉"最新版",可能跟实际需要的版本不符,浪费。所以 provider 跟 `terraform_init` 走。
>
> **为什么带 deployment 参数**:binary 是全局公共资源,但下载位置在 HOME 不可写时要 fallback 到 deployment 目录(沙箱场景)。deployment 参数为这个 fallback 而存在——常见场景(1-3 级)不用它,但签名里得带着。

#### provider_schema

```
名称: provider_schema
描述: Extract the schema of the locally installed huaweicloud terraform
      provider by running `terraform providers schema -json` in the deployment
      directory. Returns the parameter contract for resources/data-sources:
      argument names, types, required-ness, descriptions, and inter-argument
      constraints (required_with / conflicts_with). This is the authoritative
      parameter reference for writing .tf — always matches the actually
      installed provider version (unlike static docs).

      Call AFTER terraform_init (provider must be downloaded). The client LLM
      uses this to look up "what arguments does huaweicloud_compute_instance
      accept, which are required" before/while writing .tf. This complements
      terraform_examples_export (assembly templates) — schema is the parts
      list, examples are the assembly drawing.

      Differentiated from HashiCorp's official terraform-mcp-server: official
      fetches provider docs from the Terraform Registry API (network,
      version-drift risk); this tool extracts locally from the installed
      provider (offline, version-exact).
参数:
  deployment (string, required): Deployment directory (must have run terraform_init).
  resource_type (string, optional): If given, return only that resource type's
       schema (e.g. "huaweicloud_compute_instance"). If omitted, return a list
       of all available resource + data-source type names (lightweight index).
返回:
  成功 (with resource_type): { "resource_type": "...", "attributes": [
            { "name":"image_id", "type":"string", "required":true,
              "description":"...", "optional":false, "computed":false } ],
            "block_types": [...], "description": "..." }
  成功 (without resource_type): { "resource_types": ["huaweicloud_compute_instance",
            ...], "data_source_types": ["huaweicloud_compute_instances", ...] }
  失败: { "error": "provider not initialized — run terraform_init first" }
       { "error": "resource_type not found: ..." }
```

#### terraform_init

```
名称: terraform_init
描述: Run `terraform init` in the deployment directory. Downloads provider
      plugins (huaweicloud provider ~100-200MB) via terraform's native provider
      installation mechanism, initializes the backend.

      Provider mirror configuration (§6.5):
      - If <deployment>/.terraformrc already exists (user-provided), it is
        used as-is — server does NOT overwrite. TF_CLI_CONFIG_FILE points to it.
      - If <deployment>/.terraformrc does not exist, server generates one from
        provider_mirrors (default: HuaweiCloud network_mirror) and sets
        TF_CLI_CONFIG_FILE to point at it. The generated .terraformrc includes
        a direct { exclude = ["registry.terraform.io/huaweicloud/*"] } fallback
        so auxiliary providers (random, tls, ...) still reach the official registry.
      - If the user has ~/.terraformrc and no TF_CLI_CONFIG_FILE is set in the
        environment, server respects the user's home config and does not inject
        its own (the user's mirror setup takes precedence).

      Provider plugin cache (TF_PLUGIN_CACHE_DIR):
      - Set to ~/.huaweicloud-ops-deploy/plugins/ when HOME is writable —
        providers downloaded once are reused by all deployments (first init
        downloads, subsequent inits hit cache, seconds vs minutes).
      - Not set when HOME is not writable (sandbox) — providers download into
        <deployment>/.terraform/providers/ (terraform default, per-deployment).

      Binary resolution: each terraform tool call runs resolveTerraformEnv()
      internally (see §6.5) — it is stateless, re-deriving the binary path
      and env from the filesystem on every call. terraform_init does not
      "remember" what terraform_install did; it re-detects.

      Credential env (AK/SK/region/security_token) is injected by the server
      from the keychain (§5.5) — NEVER passed via tool parameters.

      Long-running if provider not cached (download ~100-200MB); fast if
      cached. Uses MCP tasks extension when long (see §8). Must be called
      after .tf files are written and before terraform_plan.

      debug=true sets TF_LOG=DEBUG for the init subprocess.
参数:
  deployment (string, required): Deployment directory containing .tf files.
  provider_mirrors (string[], optional): Provider mirror URLs (network_mirror)
       or local paths (filesystem_mirror). Default:
       ["https://mirrors.huaweicloud.com/terraform/"].
       Verified: this mirror hosts ONLY the huaweicloud provider
       (registry.terraform.io/huaweicloud/huaweicloud/<ver>.json); auxiliary
       providers (hashicorp/random, hashicorp/tls) are NOT mirrored and 404,
       so the generated .terraformrc scopes include to huaweicloud/* and lets
       direct handle the rest. Override when the default is unreachable. URLs
       starting http(s):// become network_mirror; local paths become
       filesystem_mirror.
  debug (boolean, optional): Set TF_LOG=DEBUG.
返回:
  成功 (task if uncached): { "resultType": "task", "taskId": "...", "status": "working" }
  成功 (sync if cached): { "exit_code": 0, "stdout": "...", "stderr": "...",
          "provider_cache": "global" | "per-deployment",
          "terraformrc": "user-provided" | "server-generated" | "user-home-respected" }
  task completed result: { "exit_code": 0, "stdout": "...", "stderr": "..." }
  失败: { "error": "terraform init failed: ...", "stdout": "...", "stderr": "..." }
```

#### terraform_plan

```
名称: terraform_plan
描述: Run `terraform plan` in the deployment directory. Generates an execution
      plan showing what resources will be created/modified/destroyed. Long-running
      (refreshes existing resources via cloud API, 1-3min for large deployments) —
      uses MCP tasks extension (see §8). Returns a STRUCTURED plan (terraform
      show -json) for the client LLM to parse and present to the user — the LLM
      reorganizes the structured output into human-readable form (tables/lists).
      The client should NOT call terraform_apply until the user has reviewed this
      plan AND cost.json has been updated.

      Binary/env resolution is stateless (§6.5 resolveTerraformEnv): each call
      re-derives the binary path and TF_CLI_CONFIG_FILE/TF_PLUGIN_CACHE_DIR from
      the filesystem. Credentials injected from keychain (§5.5), never via params.

      debug=true sets TF_LOG=DEBUG.
参数:
  deployment (string, required): Deployment directory.
  debug (boolean, optional): Set TF_LOG=DEBUG.
返回:
  成功 (task): { "resultType": "task", "taskId": "...", "status": "working",
                 "statusMessage": "terraform plan in progress..." }
  task completed result: { "exit_code": 0,
                 "plan_json": <terraform show -json output — structured>,
                 "summary": { "create": N, "change": N, "destroy": N },
                 "security_group_rules": [...] }
  失败: { "error": "terraform plan failed: ...", "stdout": "...", "stderr": "..." }
```

#### terraform_apply

```
名称: terraform_apply
描述: Run `terraform apply` in the deployment directory. This creates/modifies
      REAL cloud resources. This is a long-running operation — the server uses
      the MCP tasks extension to return a task handle; the client polls
      task status and receives progress notifications (see §8).

      SAFETY GATE (server-enforced, all engineering-checkable):
      1. networking.json exists in the deployment directory
         — ensures the networking design was persisted before applying
      2. cost.json exists in the deployment directory
         — ensures the user saw a price estimate
      3. cost.json.tf_hash state machine (cost.json precedes .tf, see §6.3):
         - null  → allow (first time / last apply failed); fill hash after
                   successful apply. First apply does NOT verify .tf matches
                   cost.json spec/billing — relies on LLM translation + plan review.
         - non-null → recompute current .tf SHA256 and compare; mismatch rejects.
         - This catches .tf changes after the first successful apply.
      4. no plaintext credentials in *.tf files
         — grep for access_key/secret_key/security_token assignments (see §6.3)
      If any check fails, returns an error telling the client what to fix.

      After successful apply: if cost.json.tf_hash was null, fill it with the
      current .tf hash (固化). Failed apply does NOT fill — retry stays "first time".

      Binary/env resolution is stateless (§6.5 resolveTerraformEnv). Credentials
      injected from keychain (§5.5), never via params. debug=true sets TF_LOG=DEBUG.
参数:
  deployment (string, required): Deployment directory.
  debug (boolean, optional): Set TF_LOG=DEBUG.
返回:
  成功 (task): { "resultType": "task", "taskId": "...", "status": "working",
                 "statusMessage": "terraform apply in progress..." }
  失败: { "error": "networking.json not found — call update_networking first" }
       { "error": "cost.json not found — call update_cost first" }
       { "error": "cost.json.tf_hash does not match current .tf files —
         .tf changed after cost estimate, re-run update_cost" }
       { "error": "plaintext credential found in <file>.tf: line N —
         remove access_key/secret_key/security_token assignments (see §6.2)" }
```

#### terraform_destroy

```
名称: terraform_destroy
描述: Run `terraform destroy` in the deployment directory. Permanently deletes
      all cloud resources managed by this deployment. Long-running — uses MCP
      tasks extension (see §8). The client should confirm with the user before
      calling. After destroy succeeds, the client may call delete_deployment to
      remove the directory.

      Binary/env resolution is stateless (§6.5 resolveTerraformEnv). Credentials
      injected from keychain (§5.5). debug=true sets TF_LOG=DEBUG.
参数:
  deployment (string, required): Deployment directory.
  debug (boolean, optional): Set TF_LOG=DEBUG.
返回:
  成功 (task): { "resultType": "task", "taskId": "...", "status": "working" }
  失败: { "error": "..." }
```

#### terraform_refresh

```
名称: terraform_refresh
描述: Run `terraform apply -refresh-only` in the deployment directory. Updates
      terraform.tfstate to reflect the real cloud state (without making config
      changes). Use this to detect drift — after refresh, compare the state
      with the .tf configuration. Also see terraform_state to read the updated
      state. Read-only — does not modify cloud resources.

      Binary/env resolution is stateless (§6.5 resolveTerraformEnv). Credentials
      injected from keychain (§5.5). debug=true sets TF_LOG=DEBUG.
参数:
  deployment (string, required): Deployment directory.
  debug (boolean, optional): Set TF_LOG=DEBUG.
返回:
  成功 (task): { "resultType": "task", "taskId": "...", "status": "working" }
  失败: { "error": "..." }
```

#### terraform_state

```
名称: terraform_state
描述: Read the terraform state via `terraform show -json` and return the
      structured result — resource addresses, types, and key attributes
      (e.g. ECS public IP, RDS endpoint). The LLM reorganizes this into a
      human-readable summary.

      Uses `terraform show -json` (terraform's stable public interface) rather
      than directly parsing terraform.tfstate: the tfstate file format is
      terraform's internal implementation detail and may change between
      versions; `show -json` is the supported API. Also works with remote
      state backends (S3/OSS), not just local tfstate.

      The result may be stale if resources were changed manually outside
      terraform; for the real cloud state, use terraform_refresh first.

      Binary/env resolution is stateless (§6.5 resolveTerraformEnv). Credentials
      injected from keychain (§5.5). debug=true sets TF_LOG=DEBUG.
参数:
  deployment (string, required): Deployment directory.
  debug (boolean, optional): Set TF_LOG=DEBUG.
返回:
  成功: { "state_json": <terraform show -json output — structured>,
          "security_group_rules": [...] }
  失败: { "error": "no state file — has this deployment been applied?" }
       { "error": "terraform show failed: ..." }
```

---

## 4. 状态文件 Schema

### 4.1 networking.json

组网设计文件。由 `update_networking` 写入。**此文件是 LLM 在写 .tf 之前产出的物理组网设计**——LLM 设计、LLM 写、LLM 读、LLM 画拓扑图给用户看。用户看的是图不是 JSON，所以建模准则是**准确反映华为云物理组网**（让 LLM 能写出生产级 .tf），不是"用户友好"。

**完整 schema 规范、推导过程、事实依据见 [NETWORKING-DESIGN.zh.md](NETWORKING-DESIGN.zh.md)**。本文只列要点。

文件分三层：

- **`topology`**：网络基础设施——VPC、subnets、route_tables、security_groups。server 严格校验结构。
- **`network_objects`**：独立网络对象——eips / nat_gateways / loadbalancers。各自有网络位置和连接关系，绑定目标带 `kind`（反映华为云 3 种 EIP associate 路径：instance / port / nat）。
- **`components`**：资源清单——网元类（ECS/RDS，直接挂 subnet+security_groups，主网卡隐式）、扩展网卡类（`huaweicloud_compute_interface_attach`，显式 ENI）、纯逻辑类（WAF policy、ELB listener/pool，只记 id+type）。

**为什么这么分三层（要点）**：
- 网元直接挂 subnet+security_groups 贴合华为云 provider 90% 用法（ECS `network{uuid}`、RDS `subnet_id`），不强制 ENI 中间层
- EIP/ELB/NAT 是独立网络对象不是组件附属——EIP 绑定目标因资源类型而异（ECS 绑 instance_id、RDS 绑 port_id、NAT 走 SNAT rule），必须带 `kind` 区分
- ELB member 设计阶段用 `target: <component-id>` 引用，不写 IP（`access_ip_v4` 是 computed，apply 后才有值）
- 扩展网卡作为独立 component（有自己的 id，cost 能引用），`instance` 字段引用宿主 ECS——生产级多网卡场景需要

**校验严格性分层**（server 只做工程化可判定的事）：
- **A 层（server 安全门校验）**：id 唯一性、引用一致性（subnet/sg/eip/nat/member 的引用）、CIDR 合法性。server 真用（update_networking 写入校验 + cost 引用一致性 + apply 前存在性门）。
- **B 层（结构合法性）**：枚举值、必填、端口范围。防 LLM 写结构性垃圾。
- **C 层（宽松）**：ports 语法、source 是否真合法 CIDR、description。server 不基于这些做决策，只要求字符串非空。

server 校验契约来自代码内 zod schema（不是从 `$schema` 字段读）。`$schema` 只是标识，文件是请求体不是持久契约——server 升级不保证兼容旧文件，重跑 `update_networking` 即可。

**server 不做**：校验 .tf 符合 networking 设计（HCL 语义）、安全组合理性、资源类型是否真实存在（查 provider schema 是 LLM 的事，server 只校验 `huaweicloud_` 前缀）。这些需 AI 判断，超出 server 工程化能力。

完整字段表、LLM 翻译指引（networking.json → .tf）、事实依据见 [NETWORKING-DESIGN.zh.md](NETWORKING-DESIGN.zh.md)。

### 4.2 cost.json

规格计费设计文件。由 `update_cost` 写入。**此文件在写 .tf 之前产出**——是"规格+计费+价格+来源"的设计记录，指导 .tf 编写（不是 .tf 的派生摘要）。

**完整 schema、时序推导、事实依据见 [COST-DESIGN.zh.md](COST-DESIGN.zh.md)**。本文只列要点。

两个作用：① 给 server "已估价"信号（apply 前的门）；② 给 LLM 价格记忆（回退重算时参考上次价格）。

**关键设计**：
- **cost.json 在 .tf 之前**——所以 tf_hash 写入时为 null，apply 成功后才填（见 §6.3 状态机）
- **区分 reuse / new**：复用已有资源（spec/charging 锁定，.tf 用 data source）vs 新买（选规格计费，.tf 用 resource）。total_monthly 只算 new 的
- **charging 两种 shape**（穷举验证）：包周期类（`mode: prepaid/on-demand` + period/period_unit）、带宽类（`mode: bandwidth/traffic` + share_type/size）。详见 COST-DESIGN.zh.md §5.3
- **tf_hash 状态机**：空则放行（第一次）并 apply 成功后填、非空则校验。第一次 apply 不校验 .tf 跟 cost.json 语义一致（靠 LLM 翻译 + plan review），改 .tf 后由 hash 门抓住

**校验分层**：A 层（resource 引用 networking components、source 枚举、reuse 时 existing_id 必填、charging 结构）；B 层（currency 枚举）；C 层（spec 内容、monthly 数值——给 LLM/用户看）。total_monthly 是 server 写入（自动求和 new 的 monthly）。

**server 不校验**：charging 跟 .tf 一致（HCL 语义）、价格真实性、reuse 跟已有资源一致（LLM 写入职责）、价格合理性（用户判断）。

完整字段表、LLM 翻译指引（cost.json → .tf：reuse 用 data source、new 用 resource、charging 映射参数）、tf_hash 状态机、事实依据见 [COST-DESIGN.zh.md](COST-DESIGN.zh.md)。

### 4.3 .deployment.json

deployment 状态快照文件。由 `create_deployment` 创建，每次状态变更（update_networking / update_cost / terraform_apply / terraform_destroy）由 **server** 更新。client LLM 不写此文件。

**作用**：让 server（无状态、按 deployment 操作）快速知道当前 deployment 处于什么状态 + 关联哪个账号。纯诊断/参考，不做凭证路由（单账号假设，所有工具用当前激活凭证）。

```json
{
  "created_at": "2026-09-18T10:00:00Z",
  "created_with": "huaweicloud-ops-deploy",
  "server_version": "0.1.0",
  "account": {
    "name": "default",
    "account_id": "xxx-xxx"
  },
  "status": {
    "networking_written": false,
    "cost_written": false,
    "applied": false,
    "destroyed": false,
    "last_operation": "create_deployment",
    "last_operation_at": "2026-09-18T10:00:00Z"
  }
}
```

**字段说明**：
- `account`：create_deployment 时若已 auth，记当前账号标识（name + account_id，**不含凭证**——凭证在 keychain）。若未 auth，留空，后续 auth 后 server 操作该 deployment 时补写。供 LLM/用户识别"这 deployment 是哪个账号的"
- `status`：当前态快照（不是操作日志流水）。各 boolean 表示对应文件/操作是否完成。`last_operation` 记最后一次操作类型
- `server_version`：创建时的 server 版本，诊断用（不做版本路由/迁移）

**server 不做**：凭证路由（单账号）、版本迁移、跨 deployment 状态聚合。`.deployment.json` 只供单个 deployment 内的状态查询。

---

## 5. 认证与凭证管理

### 5.1 设计目标

**前置条件**：客户端支持 elicitation capability 时，以下目标全部成立。客户端不支持 elicitation 时，退化到只读环境变量（§5.3），凭证仍不进 LLM 上下文，但无法交互式收集。

- AK/SK 不暴露给 LLM——凭证值走 MCP elicitation 的 inputResponses 通道，不进 LLM tool-call 上下文；LLM 只接触认证结果 `{ authenticated, region, account }`
- `auth()` 无参（凭证通过 elicitation 表单收集，环境变量作表单 default 预填），一次认证后续工具自动使用当前激活凭证（**单账号**）
- 凭证绑定到当前机器（换机器不可用）
- STS 临时凭证不持久化（有过期时间，401 时报"call auth"让 LLM 重新认证）
- `.deployment.json` 记账号标识仅供诊断/参考，**不做凭证路由**（单账号无需路由）

### 5.2 存储策略：Keychain 优先 + 机器指纹 fallback

**优先级 1：OS Keychain**

| 平台 | 后端 | 库 |
|---|---|---|
| macOS | Keychain | `@napi-rs/keyring` → `security` 命令 |
| Windows | DPAPI (CryptProtectData) | `@napi-rs/keyring` → Windows Credential Manager |
| Linux | Secret Service (GNOME Keyring / KWallet) | `@napi-rs/keyring` → D-Bus |

存储内容：
```
service: "huaweicloud-ops-deploy"
account: "default"
password: JSON.stringify({ ak, sk, region })
```

**service name 公开没关系**——它是命名空间标识，不是秘密。Keychain 的安全模型假设"同用户同机器可信"，真正控制访问的是 OS 层。开源代码暴露 service name 不构成安全风险（同机器同用户的其他进程本来就能调 keyring 取，但这在威胁模型可接受范围内）。

**优先级 2：机器指纹派生加密文件（fallback）**

当 OS keychain 不可用时（Linux 无桌面环境、无 keyring daemon、Docker 容器）：

```
1. 采集机器指纹: node-machine-id → OS 级机器 UUID
   (Linux: /etc/machine-id 或 /var/lib/dbus/machine-id)
   (macOS: IOPlatformUUID)
   (Windows: MachineGuid from registry)
2. 派生密钥: scrypt(machineId, salt, N=2^15, r=8, p=1, keyLen=32)
3. 加密: AES-256-GCM(key, plaintext) → ciphertext + nonce + tag
4. 存储: ~/.huaweicloud-ops-deploy/credentials.enc
```

文件格式：
```
[12 bytes nonce][16 bytes tag][ciphertext...]
```

机器指纹变了（换机器、重装 OS）→ 解密失败 → 报错重新 auth。

**注意**：`node-machine-id` 的机器 UUID 是 OS 级的，虚拟机克隆会复制 UUID——这是已知限制，不是安全漏洞（威胁模型不防同机器克隆）。

### 5.3 auth() 流程（elicitation 收凭证，不进 LLM 上下文）

auth 工具**无参**——AK/SK/region 通过 MCP elicitation 收集，走 inputResponses 通道，不经 LLM tool-call 参数。

```
auth()  ← LLM 调用,无参
  │
  ├─ 第一次执行（ctx.mcpReq.inputResponses 为空）:
  │    └─ server 先读环境变量 HW_ACCESS_KEY / HW_SECRET_KEY / HW_SECURITY_TOKEN / HW_REGION_NAME
  │       （process.env,server 侧读取,不进 LLM 上下文）
  │    └─ 返回 inputRequired({
  │         inputRequests: {
  │           credentials: inputRequired.elicit({
  │             message: env 里有凭证时 "检测到环境变量 HW_ACCESS_KEY 等,已预填,确认或修改";
  │                      无凭证时 "请输入华为云凭证",
  │             requestedSchema: {
  │               type: "object",
  │               properties: {
  │                 ak: { type: "string", title: "Access Key",
  │                       default: process.env.HW_ACCESS_KEY },   // 预填 env 值
  │                 sk: { type: "string", title: "Secret Key",
  │                       default: process.env.HW_SECRET_KEY },
  │                 region: { type: "string", title: "Region",
  │                           default: process.env.HW_REGION_NAME ?? "cn-north-4" },
  │                 security_token: { type: "string", title: "STS Token (optional)",
  │                                   default: process.env.HW_SECURITY_TOKEN }
  │               },
  │               required: ["ak", "sk", "region"]
  │             }
  │           })
  │         }
  │       })
  │       （requestedSchema 的 string 字段支持 default——auth-CUe6YdwF.mjs:1041 确认。
  │        用户看到预填值,自己决定用 env 的还是改。env 值不进 LLM 上下文,只进表单 default。）
  │    → 客户端弹表单,用户填值/确认预填值（不经 LLM）
  │    → 客户端重试 tools/call,带 inputResponses
  │
  ├─ 第二次执行（ctx.mcpReq.inputResponses 非空）:
  │    ├─ acceptedContent(ctx.mcpReq.inputResponses, "credentials", schema) 读回 {ak, sk, region, security_token?}
  │    │    └─ 用户 declined/cancelled → 返回 "elicitation declined by user"
  │    │
  │    ├─ security_token 非空（STS）？
  │    │    └─ YES: 不持久化,存内存,credential_source="session"
  │    │
  │    ├─ security_token 为空（永久 AK/SK）:
  │    │    ├─ 验证: 调 GET https://iam.{region}.myhuaweicloud.com/v3/projects（签名后）
  │    │    │    └─ 失败 → 返回 "invalid credentials"
  │    │    ├─ 存 Keychain: new Entry("huaweicloud-ops-deploy", "default").setPassword(
  │    │    │             JSON.stringify({ak, sk, region}))
  │    │    │    └─ 成功 → credential_source="keychain"
  │    │    └─ Keychain 失败 → fallback 机器指纹文件 (~/.huaweicloud-ops-deploy/credentials.enc)
  │    │         └─ credential_source="machine-bound-file"
  │    │
  └─ 返回给 LLM（LLM 只看到结果,看不到 AK/SK 值）:
       { authenticated: true, region, account: <从 /v3/projects 拿>,
         credential_source, sts: false }
```

**elicitation 数据流的关键**：用户填的 AK/SK 值走 `inputResponses` 通道，在客户端直接塞进重试请求的 `_meta`，**不经过 LLM 的 tool-call 参数**。LLM 只知道"auth 工具被调了"，看到最终返回的 `{ authenticated, region, account }`，接触不到凭证值。这实现 §5.1"客户端不接触凭证"的目标——LLM 接触不到凭证值，只接触认证结果。

**环境变量预填**：server 第一次执行时读 `process.env.HW_ACCESS_KEY`/`HW_SECRET_KEY`/`HW_SECURITY_TOKEN`/`HW_REGION_NAME`，作为 elicitation 表单字段的 `default` 值（`requestedSchema` 的 string 字段支持 `default`——auth-CUe6YdwF.mjs:1041 验证；`message` 字段在 :1146）。用户看到预填值，自己决定用 env 的还是改。env 值不进 LLM 上下文，只进表单 default。如果 env 完整覆盖凭证，用户直接确认表单无需重输。`message` 同步提示"检测到环境变量已预填"。

**era 双通**：legacyShim 默认开（d.mts:2957）。stdio 客户端协商 2025-11-25 时，`inputRequired()` 返回值由 shim 自动转成老式 `elicitation/create` server→client 请求 + handler 重入。**不要设 `legacyShim: false`**（d.mts:2959-2960，2025-era 会 loud fail）。

**客户端前提**：客户端须声明 `elicitation` capability。**怎么探测**（SDK 源码验证）：
- initialize 声明的全局能力：`server.getClientCapabilities()?.elicitation`（createMcpHandler d.mts:3012，返回 `ClientCapabilities | undefined`，含 `elicitation` 字段）
- per-request 能力（2026-07-28 era）：`ctx.mcpReq.envelope` 带客户端的 per-request capabilities（d.mts:3007）；`CLIENT_CAPABILITIES_META_KEY` 是 `_meta` 里的 key
- auth handler 里优先查 per-request（2026 era），fallback 查 initialize 全局（2025 era）

Claude Code / Cursor 支不支持得实测。**不支持 elicitation 时只走环境变量路径**（不退化成 AK/SK 入参——那会让凭证进 LLM 上下文，违反 §5.1 目标）：
- 读 `HW_ACCESS_KEY`/`HW_SECRET_KEY`/`HW_REGION_NAME`（`HW_SECURITY_TOKEN` 可选）
- env 没配 → 报错"未配置环境变量 HW_ACCESS_KEY/HW_SECRET_KEY/HW_REGION_NAME，且客户端不支持 elicitation 表单，无法认证"
- env 配了 → 验证（调 GET /v3/projects 签名验证），有效则认证通过，无效则报错"环境变量凭证无效: <API error>"

即：elicitation 是首选（交互式表单 + env 预填），env 直读是无 elicitation 时的唯一兜底。两条路径都不让凭证进 LLM 上下文。

### 5.4 凭证读取（其他工具调用时）

```
getCredentials()
  │
  ├─ 内存有 session 凭证（STS）？ → 返回 session 凭证
  │
  ├─ 尝试 Keychain：
  │    new Entry("huaweicloud-ops-deploy", "default").getPassword()
  │    └─ 成功 → JSON.parse → 返回 {ak, sk, region}
  │
  ├─ Keychain 失败 → 尝试机器指纹文件：
  │    read ~/.huaweicloud-ops-deploy/credentials.enc
  │    machineId = nodeMachineId()
  │    key = scrypt(machineId, salt, ...)
  │    plaintext = AES-GCM-Decrypt(key, ciphertext)
  │    └─ 成功 → 返回 {ak, sk, region}
  │    └─ 解密失败 → 报错 "not authenticated — call auth first"
  │
  └─ 都失败 → 报错 "not authenticated — call auth first"
```

### 5.5 凭证注入

**openapi_request**：server 内部用 AK/SK 对请求做 SDK-HMAC-SHA256 签名，不透传给客户端。

**terraform 子进程**：server 把 AK/SK/region 作为环境变量注入 terraform 子进程：
```
HW_ACCESS_KEY=<ak>
HW_SECRET_KEY=<sk>
HW_REGION_NAME=<region>
HW_SECURITY_TOKEN=<sts_token>   (if STS)
```

terraform-provider-huaweicloud 自动从这些环境变量读凭证，.tf 文件里不需要写 access_key/secret_key。

---

## 6. 安全设计

### 6.1 openapi_request 的 POST/DELETE 处理

不硬拦 POST/DELETE/PUT——允许执行，但在返回结果里附加醒目警告：

```json
{
  "status": 201,
  "headers": {...},
  "body": "...",
  "warning": "Unless the user explicitly requests it, the agent should not proactively call POST/DELETE or other impactful APIs. Every such call must inform the user of the potential consequences."
}
```

**设计理由**：硬拦会让客户端 LLM 无法执行用户明确要求的操作（如手动创建资源）。改为"执行 + 警告"，让客户端 LLM 把后果告诉用户，由用户决定。

判断逻辑：`method !== "GET"` → 附加 warning。

### 6.2 .tf 文件中的凭证安全（instructions 提示 + server 安全门）

terraform-provider-huaweicloud 从环境变量 `HW_ACCESS_KEY` / `HW_SECRET_KEY` / `HW_SECURITY_TOKEN` 读凭证。**.tf 文件中绝不应该出现凭证**：

- `providers.tf` 的 provider block 只写 `region`，不写 `access_key` / `secret_key` / `security_token`
- `terraform.tfvars` 不含凭证值
- `variables.tf` 不定义凭证变量

`instructions` 提示客户端 LLM 这条规则。`terraform_examples_export` 导出的示例 `providers.tf` 可能含 `access_key = var.access_key`（来自上游文档）——`instructions` 提示客户端 LLM 忽略这些行。

**但提示不够——server 在 `terraform_init` 和 `terraform_apply` 前做工程化安全门校验**（grep 是确定性操作，工程成本跟 tf_hash 一样低，落地成代码）：

```
scanTfCredentials(deployment):
  patterns = [
    /access_key\s*=\s*"[^"]+"/,
    /secret_key\s*=\s*"[^"]+"/,
    /security_token\s*=\s*"[^"]+"/,
    /password\s*=\s*"[^"]+"/,            # 数据库/RDS 密码也拦
  ]
  for each <deployment>/*.tf:
    for each line:
      if matches any pattern (excluding var.xxx / data.xxx 引用):
        record { file, line, pattern }
  return findings (空 = 通过)
```

**白名单**：`access_key = var.access_key`（引用变量，非明文值）不拦——只拦直接赋明文值。但这违反"不定义凭证变量"规则，所以 instructions 仍提示不要这么写；安全门只管明文泄露这一最严重情况。

**挂点**：
- `terraform_init` 前：扫描，发现明文 → 报错拒绝 init（早暴露）
- `terraform_apply` 前（§6.3 第 4 门）：再扫一次（init 后用户可能改 .tf）

### 6.3 terraform_apply 的安全门总览

`terraform_apply` 是 server 唯一强制安全门。所有门都是工程化可判定的（不需要 AI），按顺序校验：

```
applyGate(deployment):
  1. networking.json 存在？
     └─ 否 → "networking.json not found — call update_networking first"
        (存在性门：证明组网设计落过盘。弱门——无法校验 .tf 符合设计)

  2. cost.json 存在？
     └─ 否 → "cost.json not found — call update_cost first"

  3. cost.json.tf_hash 状态机（cost.json 在 .tf 之前,见 COST-DESIGN.zh.md §4）：
     ├─ tf_hash 为 null（第一次/上次失败）
     │    → 放行,apply 成功后填当前 .tf hash
     │      (第一次不校验 .tf 跟 cost.json 语义一致——靠 LLM 翻译 + plan review)
     └─ tf_hash 非空
          → 重算当前 *.tf 的 SHA256 对比
             └─ 不匹配 → "cost.json.tf_hash does not match current .tf files —
                          .tf changed after cost estimate, re-run update_cost"
             └─ 匹配 → 放行

  4. *.tf 无明文凭证（§6.2 scanTfCredentials）？
     └─ 否 → "plaintext credential found in <file>.tf: line N —
               remove access_key/secret_key/security_token assignments"

  5. 全部通过 → 执行 terraform apply（走 task，§8）
     └─ apply 成功后：若 cost.json.tf_hash 为 null,填入当前 .tf hash（固化）
        失败不填——下次仍当第一次放行,修 bug 重试不要求无谓重算 cost
```

**门强度分级**（基于"server 只能工程化判断"的事实）：
- **强门**（hash 校验）：cost.json.tf_hash 非空时校验 .tf 一致性——改 .tf 必须重算 cost
- **中门**（内容扫描）：凭证 grep —— 能确定性地检出明文
- **弱门**（存在性）：networking.json / cost.json 存在 —— 只证明"落过盘"

弱门不等于不该做——该升安全门的升了，需要 AI 判断的（.tf 是否符合 networking 设计、.tf 是否符合 cost.json 规格/计费、安全组是否合理）坚决不做，靠 LLM 翻译正确 + 人 review plan。

### 6.4 安全组规则显性化（plan/state 派生视图）

不由 server 判断安全组规则是否"合理"（那需要 AI）。但 server 做一件工程化的事：**plan/state 后，从结构化输出提取所有安全组规则，格式化成清单返回**，把埋在 plan 深处的安全组规则提到表面，方便人 review。

**实现**（确定性，不需 AI）：
```
extractSecurityGroups(planOrStateJson):
  rules = []
  for res in planned_resources[] (或 state.resources[]):
    if res.type endswith "_secgroup_rule" or "_security_group_rule":
      # provider 有两套端口字段:port_range_min/max(范围) 和 ports(字符串"80,443")
      # 提取时兼容两种:优先 ports,没有则用 port_range_min..port_range_max
      ports = res.after.ports ?? (res.after.port_range_min..res.after.port_range_max)
      rules.append({
        address: res.address,              # 如 huaweicloud_networking_secgroup_rule.ssh
        sg_resource: <从 address 提取所属 secgroup 资源名>,
        direction: res.after.direction,
        protocol: res.after.protocol,
        ports: ports,
        source: res.after.remote_ip_prefix,  # ingress 和 egress 都用同名字段
      })
  return rules   # 按 sg_resource 分组格式化
```

**数据源**：`terraform plan -out=plan.tfplan` + `terraform show -json plan.tfplan`（结构化 JSON，不是 grep 人类可读文本）。

**枚举多种资源类型**：华为云有 `huaweicloud_networking_secgroup_rule`（Neutron）和 `huaweicloud_vpc_secgroup_rule`（VPC 服务）等，提取时按 `*_secgroup_rule` / `*_security_group_rule` 后缀匹配，不写死一个。

**挂点**：
- `terraform_plan` 返回的 `summary` 增加 `security_group_rules: [...]`
- `terraform_state` 返回同样字段（apply 后实际创建的规则，比 plan 更真实）
- 不做独立工具——这是 plan/state 结果的派生视图，不该让 client LLM 记得"调完 plan 再调个 review 工具"

**注意**：plan 阶段 `security_group_id` 是 "known after apply"，不能按 id 聚合——按 `address` 里的资源名标注所属安全组即可。

### 6.5 SSH/安全组收敛

不由 server 强制——`update_networking` 的 topology 层要求每个安全组声明 ingress/egress 规则，客户端 LLM 在 `update_networking` 时规划安全组，用户 review networking.json 的 `topology.security_groups` 时看到 `0.0.0.0/0` 自己判断是否收敛。§6.4 的显性化清单进一步辅助 review。`instructions` 里提示：SSH 对 0.0.0.0/0 全开是安全风险，建议限制源 IP。

### 6.6 terraform 执行环境推导（resolveTerraformEnv，无状态）

MCP server 是无状态的——每次 tool 调用是独立的，server 不记得上一次 `terraform_install` 或 `terraform_init` 做了什么。但 terraform 子进程需要知道：binary 在哪、`.terraformrc` 在哪、`TF_PLUGIN_CACHE_DIR` 在哪、凭证 env 是什么。

解法：**每个 terraform tool（init/plan/apply/destroy/refresh/state）调用前，跑一个 `resolveTerraformEnv(deployment)` 函数**，从文件系统状态重新推导。这是几个 `stat` 调用，开销极小，不依赖任何跨调用的内存状态。

```
resolveTerraformEnv(deployment):
  # 1. binary 路径（优先级链，first match wins）
  binary = process.env.HW_TERRAFORM_PATH               # 用户在 MCP client env 里指定
    ?: <terraform_path from tool param>                 # terraform_install 时传的（仅 install 有此参数）
    ?: PATH 上有 terraform?                             # terraform version 成功
    : ~/.huaweicloud-ops-deploy/bin/terraform-* 存在?  # 之前 terraform_install 下载的
    : <deployment>/.terraform/bin/terraform 存在?      # HOME 不可写时的 fallback
    : 报错 "terraform not found — call terraform_install first"

  # 2. .terraformrc（provider mirror 配置）
  if <deployment>/.terraformrc 存在:
    env["TF_CLI_CONFIG_FILE"] = <deployment>/.terraformrc   # server 或用户生成的
  elif process.env.TF_CLI_CONFIG_FILE 已被用户设:
    尊重用户的环境变量，不覆盖                                  # 用户在 MCP client env 里设了自己的
  elif ~/.terraformrc 存在:
    不设 TF_CLI_CONFIG_FILE（terraform 默认读 home 的）        # 用户的 home 配置生效
  else:
    不设（terraform 用默认 registry，无 mirror）                # 极少见，无 mirror 直连官方

  # 3. provider cache
  if ~/.huaweicloud-ops-deploy/plugins/ 可写:
    env["TF_PLUGIN_CACHE_DIR"] = ~/.huaweicloud-ops-deploy/plugins/  # 全局共享
  else:
    不设（terraform 默认下到 <deployment>/.terraform/providers/，per-deployment）

  # 4. 凭证（从 keychain 读，§5.5）
  #    env var 名遵循 huaweicloud provider 官方文档（docs/index.md）：
  #    HW_ACCESS_KEY / HW_SECRET_KEY / HW_SECURITY_TOKEN / HW_REGION_NAME。
  creds = loadCredentials()  # keychain → fingerprint fallback
  env["HW_ACCESS_KEY"] = creds.ak
  env["HW_SECRET_KEY"] = creds.sk
  env["HW_REGION_NAME"] = creds.region
  if creds.security_token: env["HW_SECURITY_TOKEN"] = creds.security_token

  # 5. debug（tool 参数）
  if debug: env["TF_LOG"] = "DEBUG"

  return { binary, env }
```

**关键原则**：
- **无状态**：每次 tool 调用都跑这个函数，靠文件系统存在性推导，不靠内存。server 重启不丢（文件还在）。
- **凭证不走 tool 参数**：从 keychain 读，注入 env。tool 参数里的 `debug` 是唯一受控的 env 开关——不开放任意 `env` 参数（防 LLM 注入凭证或绕 state lock）。
- **用户配置优先**：用户在 MCP client 启动 env 里设的 `HW_TERRAFORM_PATH` / `TF_CLI_CONFIG_FILE` 被尊重，server 不覆盖。server 只在用户没设时才推导。
- **sandbox 友好**：HOME 不可写时自动降级到 deployment 目录或 terraform 默认行为，功能不丢。

---

## 7. MCP Instructions

server 通过 MCP `initialize` 响应的 `instructions` 字段注入操作手册，客户端 LLM 初始化时拿到。

```markdown
## huaweicloud-ops-deploy — 操作手册

本 MCP server 提供华为云基础设施部署与查询的原子能力。你是编排者——
自己决定流程、自己写 .tf、自己查 API、自己跟用户确认。Server 只提供执行手段，
做工程化可判定的安全门校验（apply 前的状态文件/凭证/价格门），不做内容判断
（架构、规格、安全组合理性由你和用户决定）。

### 与官方 terraform-mcp-server 的分工（如用户同时挂了）

- 通用 Terraform Registry 查询（provider/module 文档、TFE workspace 操作）→ 走官方 server
- 华为云 API 调用、本地 terraform 执行、华为云 provider schema 提取、编排 examples → 走本 server
- 本 server 不重复官方的 Registry 工具，专注华为云专属能力

### 部署流程（用户在每步确认）

1. `auth()` — 认证（无参，客户端弹 elicitation 表单收 AK/SK，凭证不进 LLM 上下文；首次必须，后续自动读取）
2. `create_deployment(deployment)` — 建工作目录
3. `apiexplorer()` — 查 API 定义（无参列全部服务，带 productshort 列该服务 API，加 api_name 拿 swagger；regions=true 查可用区域，endpoints=true 查各 region 的 endpoint host）
   `terraform_examples_export(dest)` — 导出 .tf 编排示例（dest 是导出目标目录，不是 deployment 工作区）
   （examples 是跨 resource 编排模板；apiexplorer 是华为云 API 定义）
4. `update_networking(deployment, {...})` — 设计**粗粒度组网**（topology：VPC/subnet/路由/安全组；network_objects：EIP/NAT/ELB；components：资源清单——只定有哪些网元，不定规格）
   ★ LLM 据此画拓扑图给用户 review，尤其 topology.security_groups 规则和 network_objects 连接关系 ★
   ★ SSH 对 0.0.0.0/0 全开是风险，建议限制源 IP ★
5. `list_existing_resources(service?, region?)` — 盘点华为云上已有可复用资源
   （返回 id/type/spec/charging/status/network，让 LLM 知道哪些组件能复用）
6. LLM 决策：每个组件 reuse 还是 new
   - reuse：spec/charging 锁定（跟已有资源），.tf 用 data source
   - new：选规格 + 计费模式（openapi_request 查 flavor/image 等可用规格）
7. `openapi_request("GET", bss 价格 API)` — 查 new 资源的真实价格
8. `update_cost(deployment, {...})` — 落盘 cost.json（规格 + 计费 + 价格 + 来源 reuse/new）
   ★ 用户 review：哪些复用、哪些新买、各自规格计费、新增月费 ★
   ★ 若价格不行，回退改 new 资源的规格/计费，重查价重算 cost（此时 .tf 还没写，回退成本低）★
9. `terraform_install()` + `terraform_init(deployment)` — 装 provider
10. `provider_schema(deployment, "huaweicloud_compute_instance")` — 查 resource 参数契约
    （写 .tf 前确认参数名/类型/必填；examples 没覆盖的参数这里查）
11. 写 .tf 文件（按 cost.json + networking.json：reuse 用 data source 引用已有资源，
    new 用 resource 创建；charging 参数按 cost.json.charging 写；忽略示例 access_key 行——
    凭证走环境变量，server apply 时硬拦明文凭证）
12. `terraform_plan(deployment)` — 看预览
    ★ 用户 review plan，尤其返回的 security_group_rules 清单 ★
13. `terraform_apply(deployment)` — 执行（server 安全门校验：networking.json 存在 + cost.json 存在 +
    tf_hash 状态机[空则放行填、非空则校验] + .tf 无明文凭证）
14. `terraform_state(deployment)` 或 `terraform_refresh(deployment)` — 验证
    （state 返回里也有 security_group_rules 清单，确认实际创建的规则）

### 安全红线（server 安全门或 instructions 强制）

- `terraform_apply` 前 server 安全门校验四门：networking.json 存在、cost.json 存在、
  tf_hash 状态机（空则放行并 apply 成功后填、非空则校验匹配）、.tf 无明文凭证——跳不过
- `terraform_init` 前也扫明文凭证（早暴露）
- `openapi_request` 调 POST/DELETE/PUT 时，必须先告知用户后果（返回里带 warning）
- `terraform_destroy` 前建议 `terraform_refresh` 确认当前状态
- .tf 文件绝不写凭证（access_key/secret_key 走环境变量 HW_ACCESS_KEY/HW_SECRET_KEY）
- `delete_deployment` 前必须 `terraform_destroy`（资源未清空会报错）

### 大陆区域备案提示

如果用户要在大陆区域（cn-north-* / cn-east-*）部署 Web 服务并绑定域名，
提醒用户：域名备案要求 ECS 包年包月 ≥ 3 个月。如果用户打算挂域名，
on-demand（按需）计费模式可能导致备案无法通过，建议从包月起步。

### 查询场景

- 查现有资源/账单/配额：`apiexplorer` 拿 API 定义 → `openapi_request` 调 GET
- 查部署状态：`terraform_state(deployment)`（本地快照）或 `terraform_refresh(deployment)`（真实云状态）
- BSS 账单 API 域名是 bss.cn-north-1.myhuaweicloud.com（不分区域）
```

---

## 8. Tasks 扩展（长时操作）

### 8.1 问题

`terraform_install` / `terraform_init` / `terraform_plan` / `terraform_apply` / `terraform_destroy` / `terraform_refresh` 都可能超过 MCP 客户端工具调用超时（60-120s）：install 下载二进制（2-3min）、init 下载 provider（无缓存时同 install）、plan refresh 云资源（1-3min）、apply/destroy/refresh 操作云资源（3-5min）。同步阻塞会超时断连，但 terraform 子进程还在跑。

### 8.2 方案：引入 ext-tasks Stable schema + 底层注册（SDK 不提供 task 运行时）

长时操作返回 `CreateTaskResult`（`resultType: "task"`），客户端用 `tasks/get` 轮询或订阅 `notifications/tasks` 接收进度。

**规范来源**：`io.modelcontextprotocol/tasks` 扩展（SEP-2663），规范在独立仓库 `modelcontextprotocol/ext-tasks`，`schema/2026-07-28/` 状态 **Stable**。我们 vendor 这个 schema（`schema.ts` + `spec.types.ts`）进仓库，作为 task 消息校验的权威类型来源。

**SDK 2.0.0 的实际支持度**（源码验证）：
- `ServerCapabilitiesSchema` **内置 `tasks` 字段**（含 `list`/`cancel`/`requests.tools`）。引用的 `ServerTasksCapabilitySchema` 在 SDK 里标 `@deprecated 2025-11-25 wire vocabulary`——但 `registerCapabilities` 运行时只做 `mergeCapabilities` 合并，**不校验 deprecated、不校验内容**（mcp-D7GmuPnv.cjs:799-804），可声明。注意：`tasks.list` 是 2025-11-25 残留，ext-tasks 2026-07-28 规范**删除了 tasks/list**（spec line 904："Because there is no tasks/list"——为防泄露其他 caller 的 task id）——**不要声明 `list: {}`**，否则客户端可能调 tasks/list 拿 method not found
- 底层 `Protocol.setRequestHandler(method: string, { params, result }, handler)` 3 参数重载**支持任意自定义 method**（SDK 文档举例 `'acme/search'`）——可注册 `tasks/get`、`tasks/cancel`
- 高层 `McpServer` 的 `registerTool()` handler 类型标注 `CallToolResult | InputRequiredResult`——**不含 CreateTaskResult**。但运行时整条链路对 CreateTaskResult 形态**不拦截**（双 era 均放行）：
  - `validateToolOutput` 只在 `outputSchema` 存在时校验（我们不声明 outputSchema → 跳过）
  - **2025-era codec**：`projectCallToolResult` → `appendTextFallbackForNonObject` 遇 `structuredContent === undefined` 直接原样返回（src-STyD_Vvf.cjs:580-591）
  - **2026-era codec**：`EXTENDED_RESULT_TYPE_METHODS = ["tools/call","prompts/get","resources/read"]`（src-STyD_Vvf.cjs:3730），`tools/call` 在列 → `if (EXTENDED_RESULT_TYPE_METHODS.includes(method)) return result`（:3758）放行 open union，注释明说"the SDK does not validate the string"
  - 用类型断言 `as unknown as CallToolResult` 绕过类型标注，运行时行为正确
- `McpServer.server` 是 `readonly` 公开属性（文档注释 "useful for advanced operations like sending notifications"）——拿到底层 Server 注册 task method + 发通知

**字段名对齐**：vendor 的 ext-tasks 2026-07-28 schema 用 `ttlMs`/`pollIntervalMs`/`createdAt`/`lastUpdatedAt`；SDK 自带的 2025 deprecated `TaskSchema` 用 `ttl`/`pollInterval`（无 Ms 后缀）——**字段名不同**。实现时只用 vendor schema，不混用 SDK 的 `TaskSchema`，避免字段名错位。

**实现骨架**：

```typescript
const mcp = new McpServer({ name, version });
const server = mcp.server;

// 1. 声明 tasks capability（必须在 connect 之前——registerCapabilities 有 guard:
//    if (this.transport) throw AlreadyConnected。不声明 list——2026-07-28 规范删除了 tasks/list）
server.registerCapabilities({
  tasks: { cancel: {}, requests: { tools: {} } }
});

// 2. vendor ext-tasks 2026-07-28 Stable schema 做 handler 校验
//    只用 vendor schema,不用 SDK 自带的 deprecated TaskSchema（字段名不同）
import { GetTaskRequestSchema, CancelTaskRequestSchema,
         TaskStatusNotificationSchema } from "./vendored/ext-tasks/schema";

// 3. 注册 task method handlers（底层 Protocol.setRequestHandler,3 参数重载）
server.setRequestHandler("tasks/get", { params: GetTaskRequestSchema, ... },
  async (params) => { /* 内存查 task,返回 DetailedTask */ });
server.setRequestHandler("tasks/cancel", { params: CancelTaskRequestSchema, ... },
  async (params) => { /* 标记 cancelled */ });

// 4. 11 个普通工具用高层 mcp.registerTool() 注册（17 总 - 6 长时）
//    （v2 API 是 registerTool,不是 v1 的 tool。签名:registerTool(name, config, cb)）
mcp.registerTool("create_deployment",
  { description: "...", inputSchema: z.object({ deployment: z.string() }) },
  async (args, ctx) => { /* ... */ return { content: [...] }; }
);

// 5. 6 个长时工具（install/init/plan/apply/destroy/refresh）handler 返回 CreateTaskResult 形态
mcp.registerTool("terraform_apply",
  { description: "...", inputSchema: z.object({ deployment: z.string() }) },
  async (args, ctx) => {
    // 校验四门（§6.3）
    // 内存创建 task { taskId, status:"working", createdAt, lastUpdatedAt, deployment }
    // spawn terraform 子进程
    // 子进程推进: server.notification({ method: "notifications/tasks", params: { taskId, status:"working", statusMessage } })
    // 子进程结束: 更新内存 task 状态
    return {
      resultType: "task", taskId, status: "working", statusMessage: "...",
      createdAt, lastUpdatedAt, ttlMs: null, pollIntervalMs: 5000
    } as unknown as CallToolResult;  // 类型断言绕过,运行时 SDK 不校验
  }
);

// 6. connect（必须在所有 registerCapabilities / setRequestHandler / registerTool 之后）
await mcp.connect(transport);
```

**task 生命周期：**

```
terraform_apply(deployment)
  │
  ├─ 校验四门（networking.json 存在 + cost.json 存在 + tf_hash 状态机 + 无明文凭证，§6.3）
  │    └─ 失败 → 返回标准 error result（不走 task）
  │
  ├─ 内存创建 task:
  │    taskId = uuid()
  │    status = "working"
  │    statusMessage = "terraform apply in progress..."
  │    createdAt = now, lastUpdatedAt = now
  │    deployment = <deployment>  # 供 tasks/get 查
  │
  ├─ 后台执行 terraform apply（子进程）
  │    ├─ 每收到 terraform 输出行 → 更新内存 task.statusMessage + lastUpdatedAt
  │    │   + server.notification({ method: "notifications/tasks", params: { taskId, status, statusMessage } })
  │    └─ 子进程结束 → 更新内存 task:
  │         成功: status="completed", result={ exit_code:0, outputs:{...} }
  │               + 若 cost.json.tf_hash 为 null,填当前 .tf hash（§6.3）
  │         失败: status="failed", error={ code:-32000, message:"..." }
  │               (不填 tf_hash——下次仍当第一次放行,§6.3)
  │
  └─ 立即返回 CreateTaskResult:
       { resultType: "task", taskId, status: "working",
         statusMessage: "terraform apply in progress...",
         createdAt, lastUpdatedAt, ttlMs: null, pollIntervalMs: 5000 }
```

**客户端轮询：**

```
tasks/get { taskId }
  → 内存有 + status="working" → 返回 WorkingTask
  → 内存有 + status="completed" → 返回 CompletedTask（result 里有 apply 输出）
  → 内存有 + status="failed" → 返回 FailedTask（error 里有失败原因）
  → 内存无 → "task not found"（没这 task 或 server 重启过,LLM 重新 apply）
```

**进度通知（server push，可选）：**

```
notifications/tasks { taskId, status:"working", statusMessage:"Creating huaweicloud_compute_instance.web..." }
notifications/tasks { taskId, status:"completed", result:{...} }
```

**客户端前提**：tasks 是扩展，客户端必须声明 `io.modelcontextprotocol/tasks` 支持才能收到 CreateTaskResult 并调 tasks/get。**怎么探测**（同 §5.3 elicitation 探测方式）：
- initialize 全局：`server.getClientCapabilities()` 不直接含 tasks 扩展声明（tasks 是扩展不是 core capability）
- per-request（2026-07-28 era）：`ctx.mcpReq.envelope` 的 `_meta[CLIENT_CAPABILITIES_META_KEY]` 里看客户端声明的 extensions 是否含 `io.modelcontextprotocol/tasks`（d.mts:3007；`CLIENT_CAPABILITIES_META_KEY` 是 _meta key）
- 探测到支持 → 返回 CreateTaskResult；不支持 → 同步阻塞等 terraform 完成，返回普通 CallToolResult（退化,有 §8.1 超时风险,仅小部署可用）

客户端支持情况见 ext-tasks 的 [client matrix](https://modelcontextprotocol.io/extensions/client-matrix)——实现时需确认目标客户端（Claude Code / Cursor 等）支持。规范要求"Never return a task to a client that did not declare support"——server 必须先探测再决定返回形态。

### 8.3 短时操作不用 task

**判定标准**：操作会不会超过 MCP 客户端工具调用超时（60-120s）。不是"比 apply 快不快"，是"会不会超时"。

**短时（同步返回，不走 task）**：
- `terraform_state` — 纯本地文件读 terraform.tfstate
- `create_deployment` / `delete_deployment` — 目录操作
- `update_networking` / `update_cost` — 写 JSON 文件 + schema 校验
- `openapi_request` — 单次 HTTP 调用（除非返回巨大响应,§4 待加分页）
- `apiexplorer` — 动态查询 APIExplorer（网络,5 个 endpoint 递进查询）
- `terraform_examples_export` — zip 解压（本地操作,~8-12M）
- `list_existing_resources` — RMS 两阶段查询（summary 概要 + detail 分页），边界是分页调用次数非超时
- `provider_schema` — 跑 `terraform providers schema -json`（本地,几秒）
- `auth` — elicitation 表单 + 一次 IAM API 验证

**长时（走 task，§8.2）**：
- `terraform_install` — 下载 terraform 二进制（~50MB）+ provider（~100-200MB）。首次安装、大陆网络访问 registry 慢,2-3min 常见
- `terraform_init` — 下载 provider 插件。install 已缓存则快（几秒）,没缓存同 install。**条件性长时**——实现时可探测缓存决定走不走 task
- `terraform_plan` — refresh 现有资源（逐个调云 API）+ 计算差异。资源多或 API 慢时累积,大型部署 1-3min 正常
- `terraform_apply` / `terraform_destroy` / `terraform_refresh` — 创建/销毁/刷新云资源,3-5min

之前把 init/plan 归"短时"是错的——"比 apply 快"不等于"在 60s 内"。

### 8.4 task 纯内存（不持久化）

task 状态**只存内存，不落盘**。server 无全局状态，不维护 task 注册表。

**为什么不持久化**：server 重启 = 进程死 = terraform 子进程也死（SIGTERM）= task 本来就废了。磁盘上的 task 文件重启后读到 "working" 也是假的（子进程早死了），没意义。存磁盘纯属过度设计。

**server 重启后的回路**：客户端拿旧 taskId 调 tasks/get → "task not found" → LLM 重新调 terraform_apply 拿新 taskId → terraform 幂等性 detect 已有资源（terraform.tfstate 还在 deployment 目录里）→ 不会重复创建。完整回路，不需要 orphaned 清理。

**没有 `.tasks/` 目录**——task 不落盘，deployment 目录内不产生 task 文件。dir 内只有 terraform 自己的文件（.terraform/、terraform.tfstate）+ server 的元文件（.deployment.json、networking.json、cost.json）+ LLM 写的 .tf。

---

## 9. 数据源

### 9.1 API 定义：动态查询（不再打包）

API 定义（swagger）通过 `apiexplorer` 工具动态查询华为云 APIExplorer 服务获取，**不打包 tgz**。理由：API 量大（310 个服务、每个上百 API），静态打包臃肿且会过时；APIExplorer 是华为云官方"元 API"，signedHttp 能直接签名调用（已验证 200）。详见 §3.2 apiexplorer。

### 9.2 terraform examples：打包数据包

| 包 | 内容 | 来源 | 大小（估） |
|---|---|---|---|
| terraform-examples.zip | terraform-provider-huaweicloud .tf 示例（按云服务分类组织） | provider 官方 git 仓库 examples 文件夹 | ~8M |

**组织方式**：按云服务分类（ecs/vpc/rds/eip/...），对齐华为云 provider 的服务划分。每类下是该服务相关 resource 的编排 .tf 样板。

**迭代策略**：当前阶段打包官方 terraform-provider-huaweicloud 的示例 .tf；后续 server 版本可逐步用自研的场景化 examples（如 wordpress-stack、rds-with-read-replica）替换/补充。examples 是可迭代内容资产，跟 server 版本绑定发布——内容会变，跟 server 一起发最简单，`npx` 跑最新 server 即拿最新 examples。

### 9.3 打包方式

terraform-examples.zip 内联进 npm 包（TS 用 `fs.readFile` 从打包资源读，或用 `@vercel/ncc` 打包进单文件——等价于 Go 的 `//go:embed` 但走 JS 打包工具链）。解压用 adm-zip（src/utils/tar.ts）。

### 9.4 export 逻辑

```typescript
async function terraform_examples_export(dest: string) {
  // 1. 如果 dest 已存在且非空 → 报错（保护用户数据，防止静默覆盖）
  // 2. 解压 examplesArchive 到 dest
  // 3. 返回 { dest, files: count, categories: [...] }
}
```

### 9.4 数据更新

数据包在构建时从 provider 官方 git 仓库（GitCode 优先，GitHub fallback）sparse checkout examples/ 目录打包。运行 `npm run fetch-examples` 重新生成 src/data/terraform-examples.zip。zip 不进 git（.gitignore），是构建产物；build 时复制到 dist/data/。

---

## 10. 错误处理

### 10.1 错误返回格式

所有工具失败时返回 MCP 标准错误结果（`isError: true` + content 数组）：

```json
{
  "isError": true,
  "content": [{ "type": "text", "text": "terraform_plan: exit code 1: ..." }]
}
```

> **关于本文档工具定义里的 `{ "error": "..." }`**：那是**示意**（描述错误情形和文案），不是协议级返回结构。实际 MCP 工具失败统一走上面的 `isError: true` + content 格式——server 把错误信息塞进 content[0].text。这样客户端 LLM 用统一的 isError 判断失败，从 content 读错误详情。工具定义里写 `{ "error": ... }` 只是为了简洁表达"什么情况下报什么错"。

### 10.2 错误分类

| 类型 | 示例 | 客户端 LLM 该怎么做 |
|---|---|---|
| 认证失败 | "not authenticated — call auth first" | 调 auth() |
| 权限不足 | "HTTP 403: insufficient permission" | 告知用户检查 IAM 权限 |
| 参数错误 | "schema validation: components[0].subnet references unknown subnet" | 修正参数重调 |
| 状态门 | "cost.json not found — call update_cost first" | 调 update_cost |
| 网络错误 | "download failed: timeout" | 重试或检查网络 |
| terraform 失败 | "terraform plan failed: exit code 1" + stdout/stderr | 读 stderr 诊断，可能改 .tf |
| 目录错误 | "directory is not empty and not a deployment" | 换目录 |

### 10.3 terraform 错误的上下文

`terraform_init` / `terraform_plan` 失败时，返回完整 stdout + stderr，让客户端 LLM 自己诊断（它能看到错误信息，自己决定改 .tf 还是查文档）。

---

## 11. 项目结构

```
huaweicloud-ops-deploy/
├── package.json
├── tsconfig.json
├── README.md
├── DESIGN.md                    # 本文档
├── src/
│   ├── index.ts                 # 入口：stdio 传输（HTTP 后置）
│   ├── server.ts                # MCP server 实例 + instructions + tasks 扩展
│   ├── tools/
│   │   ├── index.ts             # 工具注册
│   │   ├── deployment.ts        # create_deployment, delete_deployment
│   │   ├── networking.ts        # update_networking + schema 校验
│   │   ├── cost.ts              # update_cost + total_monthly 求和 + tf_hash 置 null
│   │   ├── auth.ts              # auth 工具（elicitation 收凭证 + handler 双阶段重入,§5.3）
│   │   ├── openapi.ts           # apiexplorer, openapi_request
│   │   ├── existing_resources.ts # list_existing_resources (RMS 两阶段查询)
│   │   ├── examples.ts          # terraform_examples_export
│   │   ├── provider_schema.ts   # provider_schema (terraform providers schema -json 提取)
│   │   └── terraform.ts         # terraform_install/init/plan/apply/destroy/refresh/state
│   ├── auth/
│   │   ├── keychain.ts          # OS keychain 存储 (@napi-rs/keyring)
│   │   ├── fingerprint.ts       # 机器指纹 fallback (node-machine-id + scrypt + AES-GCM)
│   │   ├── store.ts             # 统一存取接口 (keychain → fallback)
│   │   └── signer.ts            # SDK-HMAC-SHA256 签名
│   ├── schemas/
│   │   ├── networking.ts        # networking.json schema + 校验 (zod)
│   │   └── cost.ts              # cost.json schema + 校验 (zod)
│   ├── gates/                   # apply/init 前的工程化安全门
│   │   ├── cost_gate.ts         # cost.json 存在 + tf_hash 状态机 (空放行填/非空校验,§6.3)
│   │   ├── networking_gate.ts   # networking.json 存在性校验
│   │   └── credential_gate.ts   # .tf 明文凭证 grep 扫描
│   ├── tasks/
│   │   ├── manager.ts           # task 生命周期管理（纯内存,§8.4）
│   │   └── handlers.ts          # tasks/get、tasks/cancel handler（底层 setRequestHandler,§8.2）
│   ├── vendored/
│   │   └── ext-tasks/           # io.modelcontextprotocol/tasks 2026-07-28 Stable schema（vendor 进仓库）
│   │       ├── schema.ts        # Task/CreateTaskResult/GetTaskRequest 等类型
│   │       └── spec.types.ts    # 基础类型（Result/JSONRPCRequest 等,来自 ext-tasks 仓库）
│   ├── extract/
│   │   └── security_groups.ts   # 从 plan/state JSON 提取安全组规则 (§6.4)
│   ├── data/
│   │   └── terraform-examples.zip  # 打包内联的 terraform 示例（按云服务分类）
│   └── utils/
│       ├── hash.ts              # SHA256 .tf hash 计算
│       └── tar.ts               # zip 解压（adm-zip）
├── scripts/
│   └── fetch-examples.ts        # 构建前从 provider 官方 git 仓库下载 examples 打包
└── test/
    ├── networking.test.ts
    ├── cost.test.ts
    ├── credential_gate.test.ts
    ├── security_groups.test.ts
    └── auth.test.ts
```

---

## 12. 实现优先级

### Phase 1：骨架 + 核心工具（MVP）

1. MCP server 骨架（stdio 传输 + instructions）
2. `auth()` — elicitation 收凭证 + keychain/fingerprint 持久化（§5.3）
3. `openapi_request()` — SDK-HMAC-SHA256 签名
4. `create_deployment()` / `delete_deployment()`
5. `terraform_install()` / `terraform_init()` / `terraform_plan()` / `terraform_apply()` / `terraform_destroy()`
   install/init/plan/apply/destroy/refresh 都是**task 异步调用**（返回 task handle，client 用 tasks/get 轮询、tasks/cancel 取消，§8.2）。安全门在 task 启动前同步执行（快速失败不进 task）。
6. `update_networking()` + schema 校验（NETWORKING-DESIGN.zh.md）
7. `update_cost()` + total_monthly 求和 + tf_hash 置 null（COST-DESIGN.zh.md）
8. apply 前安全门集成（networking 存在 + cost 存在 + tf_hash 状态机 + 凭证 grep，§6.3）

### Phase 2：数据导出 + provider schema + 资源盘点 + 完善

9. `apiexplorer()` / `terraform_examples_export()`
10. `provider_schema()` — 本地 provider schema 提取
11. `list_existing_resources()` — 已有资源盘点（RMS 两阶段：summary 概要 + detail 分页）
12. `terraform_state()` / `terraform_refresh()`
13. 安全组规则显性化（plan/state 返回提取，§6.4）

### Phase 3：Tasks 扩展

14. tasks 扩展集成（install/init/plan/apply/destroy/refresh 走 task，纯内存）
15. progress notifications

### Phase 4：打磨

16. 错误信息优化
17. instructions 文案打磨
18. 测试覆盖

---

## 13. 开放问题

1. **数据包分发**（已定论）：API 定义改为 `apiexplorer` 动态查询（不打包）；terraform-examples.zip 打包进 npm 包。理由：examples 是可迭代内容资产，跟 server 版本绑定一起发最简单，`npx` 跑最新 server 即拿最新 examples；运行时下载反而增加版本协调复杂度。npm 包大点没关系，运行时零网络依赖（apiexplorer 依赖运行时网络，但华为云 API 本就在线）。

2. **terraform 二进制分发**（已定论）：`terraform_install()` 先检测 PATH，有合适 terraform 就用，没有再从 HashiCorp 官方 releases 下载（华为云不镜像 terraform binary，实测确认）。沙箱/容器环境网络受限时用户可自带 terraform。已落进 §3.2 terraform_install 定义。

3. **多 region 支持**：`auth()` 无参，region 通过 elicitation 表单 / env 预填收集（§5.3），设为默认 region。`openapi_request` 的 URL 里含 region——客户端 LLM 可以调其他 region 的 API（URL 里写死）。`update_networking` 的 `subnets[].az` 也可以跨 region？不，AZ 是 region 内的。默认 region 只影响 terraform provider block 的 region 字段。

4. **credentials 撤销**：没有 `deauth()` 工具——用户要清除凭证，手动调 keychain 删除或删 `~/.huaweicloud-ops-deploy/credentials.enc`。要不要加 `deauth()`？倾向不加（YAGNI），客户端 LLM 用 OS 命令清。

5. **与官方 terraform-mcp-server 的协同**（新增）：本 server 不做通用 Registry/TFE 查询，定位为官方的华为云补充（§1.6）。需在 instructions 和 README 里说明"可同时挂两个 server"。待验证：client LLM 能否正确判断"查 provider 文档走官方、本地执行走本 server"——多 server 协同对 client 编排能力有要求，需实际测试。

---

## 附录 A：工具速查表

| 工具 | 类型 | 同步/Task | 安全门 / 派生 |
|---|---|---|---|
| create_deployment | 目录管理 | 同步 | — |
| delete_deployment | 目录管理 | 同步 | 资源未清空拒绝 |
| update_networking | 状态文件 | 同步 | schema 校验 |
| update_cost | 状态文件 | 同步 | schema 校验 + total_monthly server 求和 + tf_hash 置 null |
| auth | 认证 | 同步 | — |
| apiexplorer | API 定义查询 | 同步 | — |
| openapi_request | API 调用 | 同步 | POST/DELETE 附加 warning |
| list_existing_resources | 资源盘点 | 同步 | — |
| terraform_examples_export | 数据导出 | 同步 | — |
| terraform_install | 安装 | Task | 检测 PATH 优先 |
| terraform_init | TF 执行 | Task | 凭证 grep 扫描（§6.2）；有缓存时可能短时 |
| provider_schema | TF schema | 同步 | — |
| terraform_plan | TF 执行 | Task | 返回含 security_group_rules 提取（§6.4） |
| terraform_apply | TF 执行 | Task | 四门：networking 存在 + cost 存在 + tf_hash 状态机 + 无明文凭证（§6.3）；成功后填 hash |
| terraform_destroy | TF 执行 | Task | — |
| terraform_refresh | TF 执行 | Task | — |
| terraform_state | 状态读取 | 同步 | 返回含 security_group_rules 提取（§6.4） |

## 附录 B：典型交互流程（客户端 LLM 视角）

```
用户: 帮我在华为云 cn-north-4 部署一个 WordPress

客户端 LLM:
  1. auth()                              → 客户端弹表单,用户填 AK/SK/region
                                          → 认证就绪（凭证不进 LLM 上下文）
  2. create_deployment("~/wp-deploy")     → 目录就绪
  3. terraform_examples_export("~/wp-deploy/ref")
                                          → 拿到 .tf 示例
  4. apiexplorer(productshort:"ECS", api_name:"ListCloudServers")
                                          → 拿到 API 定义（swagger）
  5. openapi_request("GET", "https://ecs.../flavors")
                                          → 查可用 ECS 规格
  6. update_networking("~/wp-deploy", {
       topology: {
         vpc: { name:"vpc-main", cidr:"192.168.0.0/16" },
         subnets: [
           { name:"subnet-web", cidr:"192.168.1.0/24", az:"cn-north-4a", route_table:"rt-web" },
           { name:"subnet-db",  cidr:"192.168.2.0/24", az:"cn-north-4b", route_table:"rt-db" }
         ],
         route_tables: [
           { name:"rt-web", routes:[{ destination:"0.0.0.0/0", next_hop_type:"nat", next_hop:"nat-web" }] },
           { name:"rt-db",  routes:[] }
         ],
         security_groups: [
           { name:"web-sg", rules:[
             { direction:"ingress", protocol:"tcp", ports:"443", source:"0.0.0.0/0" },
             { direction:"ingress", protocol:"tcp", ports:"22",  source:"<user-ip>/32" }
           ]},
           { name:"db-sg", rules:[
             { direction:"ingress", protocol:"tcp", ports:"3306", source:"192.168.1.0/24" }
           ]}
         ]
       },
       network_objects: {
         eips: [
           { id:"eip-web", bandwidth:"5Mbps", attached_to:{ kind:"instance", target:"web" } },
           { id:"eip-nat", bandwidth:"10Mbps", attached_to:{ kind:"nat", target:"nat-web" } }
         ],
         nat_gateways: [
           { id:"nat-web", subnet:"subnet-web", snat_eip:"eip-nat", snat_source_cidr:"192.168.1.0/24" }
         ]
       },
       components: [
         { id:"web", type:"huaweicloud_compute_instance",
           subnet:"subnet-web", security_groups:["web-sg"] },
         { id:"db",  type:"huaweicloud_rds_instance",
           subnet:"subnet-db",  security_groups:["db-sg"] }
       ]
     })
                                          → 物理组网设计落盘（粗粒度：有哪些网元,不定规格）
  ★ LLM 据此画拓扑图给用户：web 在 subnet-web(绑 eip-web,出站走 nat-web),db 在 subnet-db
    (只被 web 子网访问 3306),路由表 rt-web 默认走 nat-web
  ★ 告知用户: "组网如上图... web 开放 443，SSH 限制你的 IP。确认？"
  ★ 用户确认

  7. list_existing_resources(region:"cn-north-4")
                                          → 盘点已有资源：发现有个 i-xxx 的 ECS(s6.large.2,prePaid 包3月)可复用
  8. LLM 决策：web 复用 i-xxx（reuse,spec/charging 锁定）；db 新买（new,选规格+计费）
     openapi_request("GET", "https://ecs.../flavors")  → 给 db 选规格
     openapi_request("GET", "https://bss.../rate")     → 查 db + eip 价格
  9. update_cost("~/wp-deploy", {
       currency:"CNY",
       items:[
         { resource:"web", source:"reuse", existing_id:"i-xxx",
           spec:"s6.large.2 / 40GB SSD", charging:{mode:"prepaid",period:3,period_unit:"month"},
           monthly:45.60 },                                   # 已有资源当前月费,不计入 total
         { resource:"db", source:"new",
           spec:"MySQL 8.0 / s6.large.2 / 100GB", charging:{mode:"on-demand"},
           monthly:78.30 },
         { resource:"eip-web", source:"new",
           spec:"5Mbps", charging:{mode:"bandwidth",share_type:"PER",size:5},
           monthly:23.00 }
       ]
     })                                      → server 自动算 total_monthly=101.30 (只算 new), tf_hash=null
  ★ 告知用户: "web 复用已有 ECS(¥45.60/月,不新增成本),db 新买按需¥78.30/月,
    eip 新买¥23.00/月。新增月费 ¥101.30。确认？"
  ★ 若价格不行：回退改 db 规格/计费 → 重查价 → 重算 cost（.tf 还没写,回退成本低）
  ★ 用户确认

  10. terraform_install() + terraform_init("~/wp-deploy")  → provider 就绪
  11. provider_schema("~/wp-deploy", "huaweicloud_compute_instance")  → 查参数契约
  12. 写 .tf 文件（按 cost.json + networking.json：
        web 是 reuse → data "huaweicloud_compute_instance" "web" { instance_id="i-xxx" }
        db 是 new    → resource "huaweicloud_rds_instance" "db" { charging_mode="postPaid"... }
        eip 是 new   → resource "huaweicloud_vpc_eip" "eip-web" { bandwidth{charge_mode="bandwidth"...} }
        凭证走环境变量,不写 access_key）
  13. terraform_plan("~/wp-deploy")       → plan 预览
  ★ 告知用户: "Plan: 新建 db + eip,引用已有 web。确认？"
  ★ 用户确认

  14. terraform_apply("~/wp-deploy")
      → server 校验：networking.json 存在 + cost.json 存在 + tf_hash=null(第一次放行) + 无明文凭证
      → apply 成功后填 tf_hash
      → 返回 task handle → 轮询 → task completed

  15. terraform_state("~/wp-deploy")
      → 拿到 db endpoint + eip 公网 IP
  ★ 告知用户: "部署完成。WordPress 地址: http://<ip>"
```
