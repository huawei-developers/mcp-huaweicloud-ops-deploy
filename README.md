# huaweicloud-ops-deploy

An [MCP (Model Context Protocol)](https://modelcontextprotocol.io) server for deploying, querying, and operating HuaweiCloud infrastructure. Lets AI coding assistants (Claude Code, Cursor, etc.) deploy cloud resources via Terraform, query APIs, and manage costs — with safety gates that block unsafe operations.

## What it does

- **Deploy via Terraform** — create/update/destroy HuaweiCloud resources through a guided flow: networking design → cost estimation → plan → apply, with pre-apply safety gates (no plaintext credentials, cost hash matching, networking/cost files required).
- **Query cloud APIs** — discover API definitions via APIExplorer, call any HuaweiCloud API with automatic SDK-HMAC-SHA256 signing (AK/SK never exposed to the LLM).
- **Inventory existing resources** — list what you already own via RMS (Resource Management Service), with balance/coupon summary for cost context.
- **Authenticate securely** — AK/SK collected via MCP elicitation (form pops up for the user, not the LLM), stored in OS keychain, verified against IAM.

## Prerequisites

- Node.js >= 20
- `terraform` binary in PATH (or provide a path via `terraform_install`)
- HuaweiCloud AK/SK (Access Key / Secret Key)

## Install

### Via npx (recommended — no install needed)

Configure your MCP client to run via npx (see below). npx downloads the package on first use.

### From source

```bash
git clone <repo-url>
cd mcp-huaweicloud-ops-deploy
npm install
npm run fetch-examples   # downloads terraform examples from provider repo
npm run build
```

`fetch-examples` clones the huaweicloud terraform-provider repo (GitCode first, GitHub fallback) and bundles `examples/` into `src/data/terraform-examples.zip`. The zip is a build dependency — `npm run build` fails without it.

## Configure MCP client

### Claude Code

Add to `~/.claude/claude_desktop_config.json` (or project `.mcp.json`):

```json
{
  "mcpServers": {
    "huaweicloud-ops-deploy": {
      "command": "npx",
      "args": ["-y", "@huaweidevtools/mcp-huaweicloud-ops-deploy"]
    }
  }
}
```

Or from a local build:

```json
{
  "mcpServers": {
    "huaweicloud-ops-deploy": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-huaweicloud-ops-deploy/dist/index.js"]
    }
  }
}
```

### Cursor

Add to `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "huaweicloud-ops-deploy": {
      "command": "npx",
      "args": ["-y", "@huaweidevtools/mcp-huaweicloud-ops-deploy"]
    }
  }
}
```

### Environment variables (optional)

If your MCP client doesn't support elicitation (form-based credential input), set env vars on the server process:

```json
{
  "mcpServers": {
    "huaweicloud-ops-deploy": {
      "command": "node",
      "args": ["/absolute/path/to/huaweicloud-ops-deploy/dist/index.js"],
      "env": {
        "HW_ACCESS_KEY": "your-ak",
        "HW_SECRET_KEY": "your-sk",
        "HW_REGION_NAME": "cn-north-4"
      }
    }
  }
}
```

`HW_SECURITY_TOKEN` is optional (for STS temporary credentials).

## Usage

Start a conversation with your AI assistant. Typical deployment flow:

1. **Auth** — the assistant calls `auth`; you fill in AK/SK via a form (or env vars are used automatically)
2. **Create deployment** — `create_deployment(deployment)` creates a workspace directory
3. **Design networking** — `update_networking(deployment, {...})` writes the networking design (VPC/subnets/security groups)
4. **Check existing resources** — `list_existing_resources()` shows what you already own (RMS inventory + balance/coupons)
5. **Estimate cost** — `update_cost(deployment, {...})` records specs/charging/pricing
6. **Write .tf** — the assistant writes Terraform configs based on networking + cost designs (credentials via env, never in .tf)
7. **Init + plan** — `terraform_init` → `terraform_plan` (review the plan + security group rules)
8. **Apply** — `terraform_apply` (server enforces: networking.json exists, cost.json exists, tf_hash matches, no plaintext credentials)

## Tools

18 tools across 4 categories:

| Category | Tools |
|---|---|
| Deployment workspace | `create_deployment`, `delete_deployment` |
| State files | `update_networking`, `update_cost` |
| HuaweiCloud capability | `auth`, `apiexplorer`, `openapi_request`, `list_existing_resources`, `terraform_examples_export` |
| Terraform execution | `terraform_install`, `terraform_init`, `terraform_plan`, `terraform_apply`, `terraform_destroy`, `terraform_refresh`, `terraform_state`, `terraform_import`, `provider_schema` |

## Development

```bash
npm run typecheck    # tsc --noEmit
npm run test         # vitest run
npm run build        # tsc + copy examples zip to dist/
npm run fetch-examples  # regenerate examples data package
```

## Design

See [docs/design/DESIGN.zh.md](docs/design/DESIGN.zh.md) for the full design document (in Chinese), including:
- Tool specifications (§3.2)
- Authentication flow (§5)
- Safety gates (§6)
- Terraform execution environment (§6.6)

## License

MIT
