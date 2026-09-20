/**
 * The `instructions` field sent in the MCP `initialize` response.
 *
 * The client LLM reads this at startup and uses it as its operating
 * manual. Extracted from DESIGN.zh.md §7. Kept as a plain string (not
 * markdown AST) — the MCP spec carries `instructions` as a string and
 * the client renders it.
 */
export const SERVER_INSTRUCTIONS = `## huaweicloud-ops-deploy — 操作手册

任务涉及华为云资源查询、部署与运维时，优先使用 huaweicloud-ops-deploy MCP 服务。

华为云相关的 Terraform 操作（init/plan/apply/destroy/refresh/state/import/install/provider schema）
一律使用本 server 的 terraform_* 工具，不要用 shell 直接调 terraform 命令——
本 server 的工具带安全门（凭证扫描、cost hash 校验、networking/cost 存在性）、
超时保护、输出截断。裸调 terraform 绕过这些保护。

### 部署流程

关键步骤标注 ★ 必须执行。

1. \`auth()\` — 认证（无参，客户端弹 elicitation 表单收 AK/SK）
2. \`create_deployment(deployment)\` — 建工作目录
3. \`apiexplorer()\` — 查 API 定义（无参列全部服务，带 productshort 列该服务 API，加 api_name 拿契约；compact=true 返回精简契约，含 method/path/必填+可选参数，body 参数递归展开字段路径，推荐；regions=true 查可用区域+project_id，endpoints=true 查各 region 的 endpoint host 拼 URL）
   \`terraform_examples_export(dest)\` — 导出 .tf 编排示例到 dest（dest 是导出目标目录，不是 deployment 工作区）
4. \`update_networking(deployment, {...})\` — 设计粗粒度组网（topology：VPC/subnet/路由/安全组；network_objects：EIP/NAT/ELB；components：资源清单）
   ★ 落盘前必须把组网拓扑图展示给用户并取得明确同意。拓扑须含 VPC + 子网 CIDR + 安全组规则 + network_objects 连接关系，优先 HTML 渲染。用户有修改意见则继续调整，直到用户明确采纳后你才能再次调用该工具。未取得用户同意禁止推进后续任何步骤（update_cost / 写 .tf / terraform_*） ★
   ★ SSH 对 0.0.0.0/0 全开是风险，必须提示用户限制源 IP ★
5. \`list_existing_resources(service?, region?)\` — 盘点华为云上已有可复用资源
6. LLM 决策：每个组件 reuse 还是 new
   - reuse：spec/charging 锁定（跟已有资源）。写 .tf resource block 后用 \`terraform_import(deployment, address, id)\` 把已有资源导入 state
   - new：选规格 + 计费模式（openapi_request 查 flavor/image 等可用规格）
7. \`openapi_request("GET", bss 价格 API)\` — 查 new 资源的真实价格（推荐用 fields 参数只取需要的字段，避免响应内容过大）
8. \`update_cost(deployment, {...})\` — 落盘 cost.json（规格 + 计费 + 价格 + 来源 reuse/new）
   ★ 必须向用户展示费用清单：哪些复用、哪些新买、各自规格计费、新增月费合计。用户确认后才能继续 ★
9. 回顾 \`list_existing_resources\` 返回的 \`balance_summary\`（步骤 5 已查）— 告知用户余额 + 代金券
   代金券由华为云账号级自动优先扣（代金券 > 现金券 > 余额），无需在 .tf 里配置。
   若有可用代金券（count>0），提示"实际新增月费可能低于 cost.json 估算，代金券会自动优先抵扣"。
   检查每张代金券的 expire_time，若快过期提醒用户尽快用。
10. 写 .tf（按 cost.json + networking.json：reuse 用 resource block + terraform_import，new 用 resource block；凭证走环境变量，.tf 里不写 access_key/secret_key）
11. \`terraform_init(deployment)\` — 初始化 provider
12. \`provider_schema(deployment, resource_type?)\` — 查参数契约（按需）
13. \`terraform_plan(deployment)\` — 预览变更
    ★ 必须向用户展示 plan 摘要（将创建/修改/销毁哪些资源）+ security_group_rules 清单。用户确认后才能 apply ★
14. \`terraform_apply(deployment)\` — 执行（server 强制四门：networking 存在 + cost 存在 + tf_hash 匹配 + 无明文凭证）

### 销毁与同步

- 销毁部署：\`terraform_destroy(deployment)\` — 销毁该 deployment 下所有 terraform 管理的资源。huaweicloud-ops-deploy MCP 服务会校验 tfstate 非空 + 无明文凭证。
  ★ 必须向用户列出将要销毁的资源清单，取得明确同意后才能执行。销毁不可逆 ★
- 同步云上实际状态到 tfstate：\`terraform_refresh(deployment)\` — 当云上资源被外部修改（控制台改配置、手动删资源）后，用 refresh 更新 state，再 plan 看差异。
- 查看当前 tfstate：\`terraform_state(deployment)\` — 读取 state 结构（资源地址 + 属性 + 安全组规则），用于确认当前部署实际状态。

### 安全红线

- 云资源的创建和销毁只能通过 terraform_apply / terraform_destroy 完成。不要用 openapi_request 的 POST/PUT/DELETE 去创建或销毁资源——除非用户明确要求用 API 方式，且你已告知用户后果（绕过 cost 门、不进 tfstate、不可追溯）。
- 调用 terraform_apply 或 terraform_destroy 前，必须向用户说明将要创建或销毁哪些资源，并取得用户明确同意。不要静默执行。
- .tf 文件里绝不能出现 access_key/secret_key/security_token 明文赋值——server 在 init/apply 前会 grep 扫描，发现就拒绝
- apply 前 cost.json 必须存在且 tf_hash 匹配（改 .tf 必须重算 cost）
- POST/DELETE 类 API 调用（非资源创建销毁，如发券、配额调整）会执行但返回 warning，需告知用户后果

### 大陆区域备案提示

cn-north-1/cn-north-4/cn-east-3 等大陆区域，80/443 端口对外提供 web 服务需要 ICP 备案。
未备案直接开 80/443 会被拦截。提示用户：如需开 web 端口，先确认备案状态。

### 查询场景

- "我华为云上有几台 ECS？" → \`list_existing_resources(service:"ecs")\`
- "我这个月花了多少钱？" → \`openapi_request("GET", bss 账单 API)\`
- "我有多少代金券/余额？" → \`list_existing_resources()\` 看 balance_summary 字段（余额+代金券摘要），或 \`openapi_request("GET", "https://bss.myhuaweicloud.com/v2/promotions/benefits/coupons")\` 查代金券明细
- "查这个资源的参数" → \`provider_schema(deployment, "huaweicloud_compute_instance")\`
- "拆掉这个部署" → \`terraform_destroy(deployment)\`（先列资源清单给用户确认）
- "云上资源变了，同步一下" → \`terraform_refresh(deployment)\` 再 \`terraform_plan(deployment)\` 看差异
- "当前部署了哪些资源？" → \`terraform_state(deployment)\`
- "把这台已有 ECS 纳管" → 写 .tf resource block → \`terraform_import(deployment, "huaweicloud_compute_instance.myvm", "<instance-id>")\`
`;
