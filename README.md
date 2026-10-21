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

### Running more than one client on the same machine

Credentials that are not supplied through env vars are stored per **scope**. A
scope is a name that separates one client's stored credentials from another's:

```json
{
  "mcpServers": {
    "huaweicloud-ops-deploy": {
      "command": "node",
      "args": ["/absolute/path/to/huaweicloud-ops-deploy/dist/index.js"],
      "env": {
        "HUAWEICLOUD_OPS_DEPLOY_CREDENTIAL_SCOPE": "my-client"
      }
    }
  }
}
```

| | Unset | `my-client` |
|---|---|---|
| Keychain account | `default` | `my-client` |
| Fallback file | `~/.huaweicloud-ops-deploy/credentials.enc` | `~/.huaweicloud-ops-deploy/credentials.my-client.enc` |
| Keychain service | `huaweicloud-ops-deploy` | unchanged |

The keychain service is the same for every scope; the account name carries the
separation.

**Default:** `default`. Leaving the variable unset keeps the original
single-account behavior, so nothing needs migrating.

Set a scope whenever two or more clients — say an IDE extension and a CLI —
each authenticate this server. Without it they share one credential entry: the
last client to authenticate wins, and clearing credentials in one leaves the
other still working.

A scope is 1–64 characters of `[a-z0-9_-]` starting with a letter or digit;
case and surrounding whitespace are folded, so `DSH` and `dsh` are the same
scope. **An invalid scope stops the server at startup** rather than falling
back to `default` — a typo would otherwise silently put the client back on the
shared entry.

`HW_ACCESS_KEY`/`HW_SECRET_KEY` take priority over any scope: a client that
carries credentials in its own config never reads the shared storage at all.

### Read-only vs read-write mode

By default the server starts in **read-only** mode: every operation that would
create, modify, or delete cloud resources is refused. That covers
`terraform apply`/`destroy`, and every `POST`/`PUT`/`PATCH`/`DELETE` sent
through `openapi_request`. `plan`, `init`, `refresh` (`-refresh-only`),
`state` reads, and `GET`/`HEAD` API calls are still allowed.

To let the server actually apply changes, start it in **read-write** mode by
setting `HW_DEFAULT_PERMISSION` on the server process:

```json
{
  "mcpServers": {
    "huaweicloud-ops-deploy": {
      "command": "node",
      "args": ["/absolute/path/to/huaweicloud-ops-deploy/dist/index.js"],
      "env": {
        "HW_DEFAULT_PERMISSION": "read_write"
      }
    }
  }
}
```

Accepted values (case-insensitive, dashes/underscores interchangeable):

| `read_only` mode | `read_write` mode |
|---|---|
| `read_only`, `read-only`, `readonly`, `ro` | `read_write`, `read-write`, `readwrite`, `rw` |

**Default:** `read_only`. The variable is read once at startup and never
re-read, so the mode the agent runs in cannot be changed by anything the model
does at runtime. The mode can also be switched mid-session over the
`permission/set_mode` MCP method (an operator action, not something the model
calls itself); a new process always opens at the `HW_DEFAULT_PERMISSION` default.

### HTTP / remote mode

By default the server runs over **stdio** (spawned as a child process by an
MCP client). To serve it over HTTP instead — for a remote client, a shared
dev box, or behind a reverse proxy — pass `--transport http`:

```bash
npx @huaweidevtools/mcp-huaweicloud-ops-deploy --transport http --port 9527
```

| Flag | Default | Notes |
|---|---|---|
| `--transport` | `stdio` | `stdio` (default) or `http` |
| `--port` | `9527` | HTTP listen port (ignored for stdio) |
| `--host` | `127.0.0.1` | Bind address. Default is loopback only |

The server speaks the MCP Streamable HTTP transport, serving both the
2025-era and 2026-07-28 protocol revisions (the same as stdio).

**Loopback by default.** Credentials, permission mode, and the credential
scope are all process-wide state — HTTP mode keeps the same single-operator
model stdio has, which is only safe if the process is reachable from one
machine. Binding a non-loopback address (`--host 0.0.0.0`) lets other
machines reach this process's stored credentials; only do that behind a
reverse proxy that handles authentication and network isolation.

DNS-rebinding and cross-origin requests are rejected by default
(`Host`/`Origin` header guards, loopback-allowed). A non-browser MCP client
that sends no `Origin` header passes.

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

### Tool annotations (risk hints)

Every tool declares the standard MCP annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`), so a client can surface the risk level before calling. `tools/list` carries them.

| | Tools |
|---|---|
| **Read-only** (changes no cloud resource) | `apiexplorer`, `auth`, `list_existing_resources`, `terraform_plan`, `terraform_refresh`, `terraform_state`, `terraform_import`, `provider_schema` |
| **Destructive** (can delete) | `delete_deployment`, `openapi_request`, `terraform_apply`, `terraform_destroy` |
| **Other writes** | `create_deployment`, `update_networking`, `update_cost`, `terraform_install`, `terraform_init`, `terraform_examples_export` |

Two things to know:

- **These are hints, not a safety boundary.** The MCP spec classes them as advisory, and a client must not rely on them alone. Enforcement stays server-side: `terraform_apply`/`terraform_destroy` are gated by read-write mode, the cost/tf_hash gate, and the credential scanner; `openapi_request` mutations are gated by read-only mode. Annotations only help a well-behaved client decide when to ask for confirmation.
- **`openapi_request` is marked destructive** even though it serves safe `GET`s. Its annotation is tool-level and cannot vary by argument, so it reflects the worst case — it can issue a `DELETE`. The per-argument nuance lives in the tool description.

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
