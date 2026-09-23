import type { CallToolResult, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import { fail, guard, ok } from "./errors.js";
import { queryBalanceSummary } from "./balance_summary.js";
import { signedHttp } from "../auth/http.js";
import { loadAccount } from "../auth/store.js";

/**
 * list_existing_resources (§3.2).
 *
 * Lists HuaweiCloud resources the user already owns, for reuse in a deployment.
 * Two-stage query against RMS (Resource Management Service) — the unified
 * inventory API that covers ALL services (ECS, RDS, EIP, VPC, ELB, ...):
 *
 *   Stage 1 (default, no service/region/detail args): CollectAllResourcesSummary.
 *     Returns a lightweight grouped count: provider → type → region → count.
 *     Cross-region by default — the user sees where resources live before
 *     drilling in. Cheap call, small response, ideal for the "what do I have?"
 *     first question.
 *
 *   Stage 2 (service, region, or detail=true): ListAllResources. Returns the
 *     actual resource list (id/name/provider/type/region/status/properties).
 *     Service + region narrow the query. Use after the summary tells you which
 *     service/region to drill into — avoids pulling a large list blindly.
 *
 * Also returns balance_summary (BSS balances + coupons) for the full cost
 * context at the reuse/budget decision point. Balance is best-effort.
 *
 * Verified: both RMS APIs accept AK/SK signing (despite swagger
 * marking PkiTokenAuth) and return 200. domain_id in the path IS the
 * account_id (resolved at auth, stored alongside credentials). RMS host is
 * global (rms.myhuaweicloud.com, no region prefix).
 */
export function registerExistingResourcesTool(mcp: McpServer): void {
  mcp.registerTool(
    "list_existing_resources",
    {
      title: "盘点已有云资源",
      description:
        "List HuaweiCloud resources the user already owns (for reuse in a " +
        "deployment) via RMS (Resource Management Service). Two stages: " +
        "by default returns a SUMMARY (provider→type→region→count, cheap, " +
        "cross-region) so you see what exists before drilling in. Pass " +
        "service, region, or detail=true to get the full resource list " +
        "(id/name/properties — use after the summary to narrow down). Detail " +
        "mode is paginated: if the response has next_marker, pass it back as " +
        "marker to fetch the next page. Also returns balance_summary " +
        "(balances + coupons). Call AFTER update_networking and BEFORE " +
        "update_cost. Reuse eligibility is a judgment call, not decided here. " +
        "NOTE: RMS data may lag — resources recently created or destroyed may " +
        "not reflect immediately. When timing matters (e.g. verifying cleanup " +
        "after destroy), be aware this data source is not real-time.",
      inputSchema: z.object({
        service: z.string().optional().describe('Filter by RMS provider in detail mode: "vpc"|"ecs"|"rds"|"elb"|...'),
        region: z.string().optional().describe("Filter by region in detail mode. If omitted, details span all regions."),
        detail: z.boolean().optional().describe("Force detail mode (full resource list) even without service/region. Default: summary mode."),
        limit: z.number().int().min(1).max(200).optional().describe("Page size in detail mode (default 100, max 200). Ignored in summary mode."),
        marker: z.string().optional().describe("Pagination cursor from a previous detail-mode response's next_marker. Fetches the next page."),
      }),
    },
    guard(async (args) =>
      handleListExistingResources(args.service, args.region, args.detail, args.limit, args.marker),
    ),
  );
}

interface RmsSummaryEntry {
  provider: string;
  types: Array<{
    type: string;
    regions: Array<{ region_id: string; count: number }>;
  }>;
}

interface RmsResource {
  id: string;
  name: string;
  provider: string;
  type: string;
  region_id: string;
  project_id: string;
  project_name: string;
  ep_id: string;
  ep_name: string;
  created: string;
  updated: string;
  provisioning_state: string;
  tags: Record<string, unknown>;
  properties: Record<string, unknown>;
}

interface RmsListResponse {
  resources: RmsResource[];
  page_info?: { next_marker?: string; current_count?: number };
}

/**
 * Resolve the account_id (== RMS domain_id) for the RMS path param.
 * Credentials for signing are loaded separately by signedHttp at call time.
 */
async function resolveDomainId(): Promise<string> {
  const account = await loadAccount();
  if (account?.account_id) return account.account_id;
  // Fallback: if account wasn't stored (pre-verification payload), we can't
  // call RMS — it requires domain_id. Surface a clear error.
  throw new Error("account_id not available — re-run auth to verify credentials and resolve account identity");
}

async function handleListExistingResources(
  serviceFilter?: string,
  regionFilter?: string,
  detail?: boolean,
  limit = 100,
  marker?: string,
): Promise<CallToolResult> {
  let domainId: string;
  try {
    domainId = await resolveDomainId();
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
  // Credentials: loadAccount and loadCredentials share one loadPersistedPayload
  // call — if account resolved, credentials resolved too. If signing fails
  // later, signedHttp throws a clear error; no need to pre-check here.

  // Stage selection: detail mode if explicitly requested OR a filter is given
  // (service/region imply "drill in"). Default (no args) → summary.
  const wantDetail = detail === true || serviceFilter !== undefined || regionFilter !== undefined;

  // Best-effort balance summary — independent of stage, always useful at the
  // reuse/budget decision point.
  let balanceSummary = null;
  try {
    balanceSummary = await queryBalanceSummary();
  } catch {
    // BSS unreachable — balance stays null, resources still useful.
  }

  if (!wantDetail) {
    return await summaryStage(domainId, balanceSummary);
  }
  return await detailStage(domainId, serviceFilter, regionFilter, limit, marker, balanceSummary);
}

/** Stage 1: CollectAllResourcesSummary — grouped counts, cross-region. */
async function summaryStage(
  domainId: string,
  balanceSummary: Awaited<ReturnType<typeof queryBalanceSummary>> | null,
): Promise<CallToolResult> {
  const url = new URL(`https://rms.myhuaweicloud.com/v1/resource-manager/domains/${domainId}/all-resources/summary`);
  try {
    const resp = await signedHttp("GET", url, "");
    if (resp.status !== 200) {
      return fail(`RMS summary failed (HTTP ${resp.status}): ${resp.body.slice(0, 200)}`);
    }
    const entries = JSON.parse(resp.body) as RmsSummaryEntry[];
    // Reshape into a compact form: provider → [{type, total, regions:[{region,count}]}]
    const summary = entries.map((e) => ({
      provider: e.provider,
      types: e.types.map((t) => ({
        type: t.type,
        total: t.regions.reduce((sum, r) => sum + r.count, 0),
        regions: t.regions.map((r) => ({ region: r.region_id, count: r.count })),
      })),
    }));
    const totalResources = summary.reduce(
      (sum, p) => sum + p.types.reduce((s, t) => s + t.total, 0),
      0,
    );
    return ok(
      JSON.stringify({
        mode: "summary",
        providers: summary,
        total_resources: totalResources,
        hint: "Pass service, region, or detail=true to list specific resources.",
        balance_summary: balanceSummary,
      }),
    );
  } catch (err) {
    return fail(`RMS summary failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Stage 2: ListAllResources — one page of the resource list.
 *
 * Pagination is caller-controlled (standard MCP pattern): the caller passes
 * `marker` from a previous response's `next_marker` to fetch the next page.
 * The server does NOT auto-paginate or truncate — that would either hide
 * resources behind a cap (deployment-decision bug) or fetch unboundedly
 * (slow, large response). The caller decides whether to keep paging.
 *
 * service filter is client-side (RMS v1 `type` param requires "provider.type"
 * format, no provider-only filter). When a service filter is given WITHOUT a
 * region filter, RMS returns mixed-service pages that may contain zero
 * matching resources — the caller would see `count: 0, has_more: true` and
 * waste turns paging through empty pages. To avoid this, the server
 * auto-advances through empty pages (up to MAX_AUTO_PAGES) when filtering by
 * service without region, collecting matching resources until the page has
 * results or RMS is exhausted.
 */
const MAX_AUTO_PAGES = 10;

async function detailStage(
  domainId: string,
  serviceFilter: string | undefined,
  regionFilter: string | undefined,
  limit: number,
  marker: string | undefined,
  balanceSummary: Awaited<ReturnType<typeof queryBalanceSummary>> | null,
): Promise<CallToolResult> {
  // When filtering by service without region, auto-advance through empty
  // pages. With a region filter (or no service filter), return the page as-is
  // — the density is high enough that empty pages are rare.
  const autoAdvance = Boolean(serviceFilter) && !regionFilter;

  let collected: RmsResource[] = [];
  let nextMarker = marker;
  let pagesFetched = 0;
  let exhausted = false;

  try {
    do {
      const url = new URL(`https://rms.myhuaweicloud.com/v1/resource-manager/domains/${domainId}/all-resources`);
      url.searchParams.set("limit", String(limit));
      if (regionFilter) url.searchParams.set("region_id", regionFilter);
      if (nextMarker) url.searchParams.set("marker", nextMarker);

      const resp = await signedHttp("GET", url, "");
      if (resp.status !== 200) {
        return fail(`RMS list failed (HTTP ${resp.status}): ${resp.body.slice(0, 200)}`);
      }
      const data = JSON.parse(resp.body) as RmsListResponse;
      const pageResources = data.resources ?? [];
      nextMarker = data.page_info?.next_marker;
      pagesFetched++;

      const matching = serviceFilter
        ? pageResources.filter((r) => r.provider === serviceFilter)
        : pageResources;
      collected.push(...matching);

      // Stop if: no more pages, or we have results (auto-advance only seeks
      // past empty pages, not past pages with matches).
      if (!nextMarker) { exhausted = true; break; }
      if (!autoAdvance || matching.length > 0) break;
    } while (autoAdvance && pagesFetched < MAX_AUTO_PAGES);
  } catch (err) {
    return fail(`RMS list failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Normalize: flatten RMS fields. properties is passed through raw — it's
  // service-specific (ECS has flavor/vpc/subnet, VPC has cidr, EIP has
  // public_ip, etc.). LLM reads properties to judge reuse eligibility — we
  // don't over-normalize and lose info.
  const normalized = collected.map((r) => ({
    id: r.id,
    name: r.name,
    provider: r.provider,
    type: r.type,
    region: r.region_id,
    project_id: r.project_id,
    enterprise_project: r.ep_name,
    status: r.provisioning_state,
    created: r.created,
    updated: r.updated,
    tags: r.tags,
    properties: r.properties,
  }));

  const hitAutoPageLimit = autoAdvance && pagesFetched >= MAX_AUTO_PAGES && !exhausted;
  return ok(
    JSON.stringify({
      mode: "detail",
      resources: normalized,
      count: normalized.length,
      region: regionFilter ?? "(all regions)",
      ...(serviceFilter ? { service_filter: serviceFilter } : {}),
      ...(nextMarker && !exhausted ? {
        next_marker: nextMarker,
        has_more: true,
        ...(autoAdvance ? { note: `auto-skipped ${pagesFetched} empty page(s); pass next_marker as marker to continue` } : { note: "pass next_marker as marker to fetch the next page" }),
      } : { has_more: false }),
      ...(hitAutoPageLimit ? { warning: `stopped after ${MAX_AUTO_PAGES} pages — narrow with region to reduce scope` } : {}),
      balance_summary: balanceSummary,
    }),
  );
}
