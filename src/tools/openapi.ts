import type { CallToolResult, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { JSONPath } from "jsonpath-plus";

import { fail, guard, ok } from "./errors.js";
import { signedHttp } from "../auth/http.js";

/**
 * apiexplorer + openapi_request (§3.2).
 *
 * apiexplorer wraps HuaweiCloud APIExplorer (the "API of APIs") — a dedicated
 * tool, NOT just openapi_request, because:
 *   - ListApis is paginated (a service can have 100+ APIs); the server handles
 *     limit/offset + has_more so the LLM doesn't hand-compute pagination.
 *   - ShowApi returns a large swagger with metadata the LLM doesn't need; the
 *     server strips to paths/parameters/definitions.
 *
 * Five recursive levels (APIExplorer is a global service, one unified host):
 *   1. No args → ListProductsV4: all cloud services (productshort + api_count).
 *      The LLM learns productshort values here.
 *   2. productshort (no api_name) → ListApis: that service's APIs. Paginated.
 *   3. productshort + api_name → ShowApi: the API's swagger — the parameter
 *      contract the LLM needs to call openapi_request correctly.
 *   4. regions=true → ListRegionsV4: regions where the service/API is available
 *      (region_id + project_id). Use before openapi_request to confirm region
 *      support and get the project_id for region-scoped endpoints.
 *   5. endpoints=true → ListGroups: per-region endpoint hosts (domain_url) for
 *      the service. Use to construct the full API URL for openapi_request.
 *
 * APIExplorer is itself a HuaweiCloud API — signedHttp signs it like any other
 * (RMS, BSS).
 */
export function registerOpenApiTools(mcp: McpServer): void {
  mcp.registerTool(
    "apiexplorer",
    {
      title: "查询华为云 API 定义",
      description:
        "Discover HuaweiCloud API definitions via APIExplorer. Five levels: " +
        "(1) no args → list all cloud services (productshort + api_count); " +
        "(2) productshort → list that service's APIs (name + summary, paginated); " +
        "(3) productshort + api_name → API contract; pass compact=true for a " +
        "minimal contract (method/path/required_params/optional_params, ~500B) " +
        "instead of the full swagger (5-10KB). compact is recommended — it has " +
        "every field needed to call openapi_request and is easier to scan. " +
        "(4) regions=true → regions where the service/API is available (region_id + project_id); " +
        "(5) endpoints=true → per-region endpoint hosts for the service (domain_url). " +
        "Use these to find correct endpoints and parameters before calling openapi_request.",
      inputSchema: z.object({
        productshort: z.string().optional().describe('Service short name, obtained by calling this tool without productshort to list all services. e.g. "ECS"|"VPC"|"RDS"|"EIP"|"ELB"|"ModelArts". Omit on first call to get the full list.'),
        api_name: z.string().optional().describe("API name within the service, e.g. ListCloudServers. Requires productshort."),
        compact: z.boolean().optional().describe("Level 3 only: return a minimal contract (method/path/required_params/optional_params) instead of the full swagger. Recommended — 5KB→~500B, has every field needed to call openapi_request. Use compact=false if you need body schema details (definitions)."),
        regions: z.boolean().optional().describe("List regions where this service/API is available (region_id + project_id). Requires productshort."),
        endpoints: z.boolean().optional().describe("List per-region endpoint hosts for the service (domain_url). Requires productshort. Use to construct the full URL for openapi_request."),
        limit: z.number().int().min(1).max(100).optional().describe("Page size for ListApis/ListGroups (default 50, max 100 per APIExplorer swagger)."),
        offset: z.number().int().min(0).optional().describe("Pagination offset for ListApis/ListGroups."),
      }),
    },
    guard(async (args) => handleApiExplorer(args.productshort, args.api_name, args.compact, args.regions, args.endpoints, args.limit, args.offset)),
  );

  mcp.registerTool(
    "openapi_request",
    {
      title: "调用华为云 API",
      description:
        "Send a signed HTTP request to a HuaweiCloud API endpoint. Credentials " +
        "are read from secure storage and used to sign the request — AK/SK are " +
        "never exposed in arguments. GET requests are safe; POST/PUT/DELETE " +
        "execute but the response includes a warning to inform the user of " +
        "consequences.",
      inputSchema: z.object({
        method: z.enum(["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD"]).describe("HTTP method"),
        url: z.string().describe("Full URL, e.g. https://ecs.cn-north-4.myhuaweicloud.com/v1/..."),
        body: z.string().optional().describe("Request body (JSON string) for POST/PUT"),
        headers: z.record(z.string(), z.string()).optional(),
        fields: z.array(z.string()).optional().describe("JSONPath expressions (RFC 9535) to extract from the JSON response, e.g. [\"$.account_balances[*].amount\", \"$.currency\"]. Supports array wildcards ([*]), indices ([0]), filters ([?(@.amount>0)]), and recursive descent (..). Simple dot-paths like \"data.bills\" still work. Returns {path, value} pairs; missing paths → null, wildcard paths → array of matches. Avoids pulling large responses into context. Ignored if body is not valid JSON."),
      }),
    },
    guard(async (args) => handleOpenApiRequest(args.method, args.url, args.body, args.headers ?? {}, args.fields)),
  );
}

// APIExplorer is a global service — one host serves all endpoints.
// Verified: apiexplorer.cn-north-4.myhuaweicloud.com returns 200 for
// ListProductsV4, ListApis, ShowApi, and ListRegionsV4. The swagger files list
// different region hosts (ap-southeast-3, cn-north-1, cn-north-4) but those are
// just regional replicas — one unified host suffices.
const APIEXPLORER_HOST = "apiexplorer.cn-north-4.myhuaweicloud.com";
// X-Language: zh-cn — APIExplorer returns Chinese service/region names with it
// (swagger defines X-Language enum: zh-cn | en-us). Default without it is English.
const ZH_CN_HEADERS = { "X-Language": "zh-cn" };

async function handleApiExplorer(
  productshort?: string,
  apiName?: string,
  compact?: boolean,
  regions?: boolean,
  endpoints?: boolean,
  limit = 50,
  offset = 0,
): Promise<CallToolResult> {
  if (apiName && !productshort) {
    return fail("api_name requires productshort — call apiexplorer without args to list services first");
  }
  if ((regions || endpoints) && !productshort) {
    return fail("regions/endpoints requires productshort — call apiexplorer without args to list services first");
  }

  if (!productshort) {
    return await listProducts();
  }
  if (endpoints) {
    return await listEndpoints(productshort, limit, offset);
  }
  if (regions) {
    return await listRegions(productshort, apiName);
  }
  if (!apiName) {
    return await listApis(productshort, limit, offset);
  }
  return await showApi(productshort, apiName, compact ?? false);
}

/**
 * Level 1: list all cloud services with their productshort + api_count.
 *
 * ListProductsV4 has no pagination (swagger defines no limit/offset). It returns
 * ~310 services; the server strips each product to the 5 fields the LLM needs
 * (group/name/productshort/api_count/is_global), dropping link/icon/description/
 * has_data/etc. — 65KB raw → ~28KB slim, fits one response without paging.
 */
async function listProducts(): Promise<CallToolResult> {
  const url = new URL(`https://${APIEXPLORER_HOST}/v4/products`);
  try {
    const resp = await signedHttp("GET", url, "", ZH_CN_HEADERS);
    if (resp.status !== 200) {
      return fail(`APIExplorer ListProductsV4 failed (HTTP ${resp.status}): ${resp.body.slice(0, 200)}`);
    }
    const data = JSON.parse(resp.body) as { groups?: Array<{ name: string; products?: Array<{ name: string; productshort: string; api_count: number; is_global?: boolean }> }> };
    const products = (data.groups ?? []).flatMap((g) =>
      (g.products ?? []).map((p) => ({
        group: g.name,
        name: p.name,
        productshort: p.productshort,
        api_count: p.api_count,
        is_global: p.is_global ?? false,
      })),
    );
    return ok(JSON.stringify({ products, count: products.length }));
  } catch (err) {
    return fail(`APIExplorer ListProductsV4 failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Level 2: list APIs for a service. Paginated via limit/offset. */
async function listApis(productshort: string, limit: number, offset: number): Promise<CallToolResult> {
  const url = new URL(`https://${APIEXPLORER_HOST}/v2/apis`);
  url.searchParams.set("productshort", productshort);
  url.searchParams.set("limit", String(limit));
  url.searchParams.set("offset", String(offset));
  try {
    const resp = await signedHttp("GET", url, "", ZH_CN_HEADERS);
    if (resp.status !== 200) {
      return fail(`APIExplorer ListApis failed (HTTP ${resp.status}): ${resp.body.slice(0, 200)}`);
    }
    const data = JSON.parse(resp.body) as { count?: number; apis?: Array<{ name: string; summary?: string; tags?: string }> };
    const apis = (data.apis ?? []).map((a) => ({
      name: a.name,
      summary: a.summary ?? "",
      tags: a.tags ?? "",
    }));
    return ok(JSON.stringify({
      productshort,
      apis,
      count: apis.length,
      total: data.count ?? apis.length,
      offset,
      ...(apis.length + offset < (data.count ?? apis.length) ? { has_more: true, next_offset: offset + limit } : { has_more: false }),
    }));
  } catch (err) {
    return fail(`APIExplorer ListApis failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Level 3: API contract. compact=true → minimal contract; false → full swagger. */
async function showApi(productshort: string, apiName: string, compact: boolean): Promise<CallToolResult> {
  const url = new URL(`https://${APIEXPLORER_HOST}/v3/apis/detail`);
  url.searchParams.set("productshort", productshort);
  url.searchParams.set("name", apiName);
  try {
    const resp = await signedHttp("GET", url, "", ZH_CN_HEADERS);
    if (resp.status !== 200) {
      return fail(`APIExplorer ShowApi failed (HTTP ${resp.status}): ${resp.body.slice(0, 200)}`);
    }
    const data = JSON.parse(resp.body) as ShowApiResponse;
    if (compact) {
      return ok(JSON.stringify(extractCompactContract(data)));
    }
    // Full swagger — pass through paths/parameters/definitions.
    return ok(JSON.stringify({
      name: data.name,
      summary: data.summary ?? "",
      host: data.host ?? "",
      base_path: data.base_path ?? "",
      paths: data.paths ?? {},
      parameters: data.parameters ?? {},
      definitions: data.definitions ?? {},
    }));
  } catch (err) {
    return fail(`APIExplorer ShowApi failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// --- ShowApi response types (swagger 2.0) ---

export interface ShowApiResponse {
  name: string;
  summary?: string;
  host?: string;
  base_path?: string;
  schemes?: unknown;
  paths?: Record<string, Record<string, unknown>>;
  parameters?: Record<string, SwaggerParameter>;
  definitions?: Record<string, unknown>;
}

interface SwaggerParameter {
  name?: string;
  in?: string;
  required?: boolean;
  type?: string;
  description?: string;
  schema?: { $ref?: string; description?: string; type?: string };
  $ref?: string;
}

// --- compact contract extraction ---

interface CompactParam {
  name: string;
  in: string;
  type: string;
  required: boolean;
  description: string;
  /** Body params only: flat field paths (e.g. "product_infos[].cloud_service_type"). */
  fields?: BodyField[];
}

interface CompactOperation {
  method: string;
  path: string;
  required_params: CompactParam[];
  optional_params: CompactParam[];
}

interface CompactContract {
  name: string;
  summary: string;
  host: string;
  base_path: string;
  operations: CompactOperation[];
}

const HTTP_METHODS = ["get", "post", "put", "delete", "patch", "head", "options"] as const;

/**
 * Extract a minimal API contract from a swagger 2.0 ShowApi response.
 *
 * For each path+method, collect the operation's parameters split into
 * required/optional groups. Each parameter carries name/in/type/description —
 * everything the LLM needs to construct the request. definitions/responses are
 * dropped (use compact=false if body schema detail is needed).
 *
 * $ref parameters ("#/parameters/Foo") are resolved from the top-level
 * `parameters` map. body parameters (in: "body") keep their description but
 * don't expand the schema — that would re-introduce the large JSON compact
 * is meant to avoid.
 */
export function extractCompactContract(data: ShowApiResponse): CompactContract {
  const operations: CompactOperation[] = [];
  const paths = data.paths ?? {};
  const sharedParams = data.parameters ?? {};

  for (const [path, methods] of Object.entries(paths)) {
    if (!methods || typeof methods !== "object") continue;
    for (const method of HTTP_METHODS) {
      const op = methods[method];
      if (!op || typeof op !== "object") continue;
      const rawParams = (op as { parameters?: SwaggerParameter[] }).parameters ?? [];
      const resolved = rawParams.map((p) => resolveParam(p, sharedParams));
      const definitions = data.definitions ?? {};
      const compactParams = resolved.map((p) => toCompactParam(p, definitions));
      operations.push({
        method: method.toUpperCase(),
        path,
        required_params: compactParams.filter((p) => p.required),
        optional_params: compactParams.filter((p) => !p.required),
      });
    }
  }

  return {
    name: data.name,
    summary: data.summary ?? "",
    host: data.host ?? "",
    base_path: data.base_path ?? "",
    operations,
  };
}

/** Resolve a $ref parameter against the top-level parameters map. */
function resolveParam(p: SwaggerParameter, shared: Record<string, SwaggerParameter>): SwaggerParameter {
  if (!p.$ref) return p;
  // "#/parameters/Foo" → "Foo"
  const refName = p.$ref.split("/").pop();
  if (refName && shared[refName]) return shared[refName];
  return { name: `(unresolved ref: ${refName ?? p.$ref})`, in: "unknown", required: false };
}

/**
 * Convert a resolved swagger parameter to the compact shape.
 *
 * For body parameters (in: "body"), recursively expand the schema into a
 * flat list of field paths with types — e.g. "product_infos[].cloud_service_type".
 * This gives the LLM every required field needed to construct the body,
 * including nested array items, without pulling the full swagger.
 */
function toCompactParam(
  p: SwaggerParameter,
  definitions: Record<string, unknown>,
): CompactParam {
  if (p.in !== "body") {
    return {
      name: p.name ?? "",
      in: p.in ?? "query",
      type: p.type ?? (p.schema?.type ?? "string"),
      required: p.required ?? false,
      description: p.description ?? "",
    };
  }
  // Body param — recursively expand into flat field paths.
  const fields = expandBodySchema(p.schema ?? {}, definitions, "");
  return {
    name: p.name ?? "body",
    in: "body",
    type: "object",
    required: p.required ?? false,
    description: p.description ?? p.schema?.description ?? "",
    ...fields.length > 0 ? { fields } : {},
  };
}

/** A flat field path in the body schema. */
interface BodyField {
  path: string;
  type: string;
  required: boolean;
  description: string;
}

/**
 * Recursively expand a swagger schema into flat field paths.
 *
 * - Object: expand each property, prefix with parent path
 * - Array: expand items, mark path with "[]"
 * - $ref: resolve from definitions, continue expanding
 * - Leaf (string/number/boolean): emit the path
 *
 * Stops at leaves or when a $ref can't be resolved. All fields are
 * included — each marked required/optional so the LLM knows which are
 * mandatory and which are optional.
 */
function expandBodySchema(
  schema: { $ref?: string; type?: string; properties?: Record<string, unknown>; items?: unknown; required?: string[]; description?: string },
  definitions: Record<string, unknown>,
  pathPrefix: string,
): BodyField[] {
  // Resolve $ref
  if (schema.$ref) {
    const refName = schema.$ref.split("/").pop();
    if (!refName) return [];
    const def = definitions[refName] as typeof schema | undefined;
    if (!def) return [];
    return expandBodySchema(def, definitions, pathPrefix);
  }
  // Leaf type — no properties, no items
  if (schema.type && schema.type !== "object" && schema.type !== "array") {
    return [];
  }
  // Object — expand properties
  if (schema.type === "object" || schema.properties) {
    const props = schema.properties ?? {};
    const required = new Set(schema.required ?? []);
    const fields: BodyField[] = [];
    for (const [name, subSchema] of Object.entries(props)) {
      const sub = subSchema as typeof schema;
      const path = pathPrefix ? `${pathPrefix}.${name}` : name;
      const isRequired = required.has(name);
      // Recurse into the property
      const nested = expandBodySchema(sub, definitions, path);
      if (nested.length > 0) {
        fields.push(...nested);
      } else {
        // Leaf field
        fields.push({
          path,
          type: sub.type ?? "string",
          required: isRequired,
          description: sub.description ?? "",
        });
      }
    }
    return fields;
  }
  // Array — expand items with "[]" suffix
  if (schema.type === "array" && schema.items) {
    const itemSchema = schema.items as typeof schema;
    const arrayPath = `${pathPrefix}[]`;
    const nested = expandBodySchema(itemSchema, definitions, arrayPath);
    if (nested.length > 0) return nested;
    // Array of leaf type
    return [{
      path: arrayPath,
      type: `array<${itemSchema.type ?? "string"}>`,
      required: true,
      description: schema.description ?? "",
    }];
  }
  return [];
}

/**
 * Level 4: list regions where a service (or specific API) is available.
 *
 * HuaweiCloud doesn't expose every service in every region — the LLM needs
 * this to confirm a target region supports the service/API before calling
 * openapi_request, and to get the project_id for region-scoped endpoints.
 * If api_name is given, regions are scoped to that API; otherwise to the
 * service (productshort).
 */
async function listRegions(productshort: string, apiName?: string): Promise<CallToolResult> {
  const url = new URL(`https://${APIEXPLORER_HOST}/v4/regions`);
  url.searchParams.set("product_short", productshort);
  if (apiName) url.searchParams.set("api_name", apiName);
  try {
    const resp = await signedHttp("GET", url, "", ZH_CN_HEADERS);
    if (resp.status !== 200) {
      return fail(`APIExplorer ListRegionsV4 failed (HTTP ${resp.status}): ${resp.body.slice(0, 200)}`);
    }
    const data = JSON.parse(resp.body) as { regions?: Array<{ name?: string; name_cn?: string; region_id: string; has_permission?: boolean; projects?: { project_id?: string; name?: string } }> };
    const regions = (data.regions ?? []).map((r) => ({
      name: r.name_cn ?? r.name ?? r.region_id,
      region_id: r.region_id,
      has_permission: r.has_permission ?? false,
      project_id: r.projects?.project_id ?? "",
    }));
    return ok(JSON.stringify({
      productshort,
      ...(apiName ? { api_name: apiName } : {}),
      regions,
      count: regions.length,
    }));
  } catch (err) {
    return fail(`APIExplorer ListRegionsV4 failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Level 5: per-region endpoint hosts for a service (ListGroups).
 *
 * Returns {region_id, domain_url} per region — the LLM needs domain_url to
 * construct the full API URL for openapi_request (e.g.
 * https://ecs.cn-north-4.myhuaweicloud.com/v1/...). ShowApi returns one
 * host for one region; this gives all regions' endpoint hosts.
 */
async function listEndpoints(productshort: string, limit: number, offset: number): Promise<CallToolResult> {
  const url = new URL(`https://${APIEXPLORER_HOST}/v1/groups`);
  url.searchParams.set("productshort", productshort);
  url.searchParams.set("limit", String(limit));
  url.searchParams.set("offset", String(offset));
  try {
    const resp = await signedHttp("GET", url, "", ZH_CN_HEADERS);
    if (resp.status !== 200) {
      return fail(`APIExplorer ListGroups failed (HTTP ${resp.status}): ${resp.body.slice(0, 200)}`);
    }
    const data = JSON.parse(resp.body) as { groups?: Array<{ region_id: string; domain_url: string }> };
    const endpoints = (data.groups ?? []).map((g) => ({
      region: g.region_id,
      host: g.domain_url,
    }));
    return ok(JSON.stringify({
      productshort,
      endpoints,
      count: endpoints.length,
    }));
  } catch (err) {
    return fail(`APIExplorer ListGroups failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function handleOpenApiRequest(
  method: string,
  url: string,
  body: string | undefined,
  headers: Record<string, string>,
  fields?: string[],
): Promise<CallToolResult> {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    return fail(`invalid URL: ${url}`);
  }

  let resp;
  try {
    resp = await signedHttp(method.toUpperCase(), parsedUrl, body ?? "", headers);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("not authenticated")) return fail("not authenticated — call auth first");
    return fail(`request failed: ${msg}`);
  }

  const result: Record<string, unknown> = {
    status: resp.status,
    headers: resp.headers,
  };
  if (method.toUpperCase() !== "GET") {
    result["warning"] =
      "Unless the user explicitly requests it, the agent should not proactively " +
      "call POST/DELETE or other impactful APIs. Every such call must inform the " +
      "user of the potential consequences.";
  }

  // If fields requested and body is valid JSON, extract only those paths.
  if (fields && fields.length > 0) {
    const extracted = extractFields(resp.body, fields);
    if (extracted !== undefined) {
      result["extracted"] = extracted;
      // If ALL extracted values are null, the paths don't exist in the
      // response. Include top-level keys so the LLM can correct the paths.
      if (extracted.every((e) => e.value === null)) {
        try {
          const parsed = JSON.parse(resp.body);
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            result["hint"] = `fields not found — top-level keys: ${Object.keys(parsed).join(", ")}`;
          }
        } catch { /* not JSON, no hint */ }
      }
      return ok(JSON.stringify(result));
    }
  }

  // Body: when content-type is JSON, embed the parsed object directly — not a
  // JSON string. This avoids forcing the LLM to json.loads the body twice
  // (once to unwrap the tool result, once to unwrap the body string). Non-JSON
  // bodies (OBS XML, plain text) are kept as strings. Empty bodies (204 No
  // Content, empty 200) omit the body field — body: "" would only confuse.
  if (resp.body) {
    const ct = (resp.headers["content-type"] ?? "").toLowerCase();
    if (ct.includes("json")) {
      try {
        result["body"] = JSON.parse(resp.body);
      } catch {
        // Malformed JSON despite content-type header — keep raw string so the
        // caller can see what came back instead of silently dropping it.
        result["body"] = resp.body;
      }
    } else {
      result["body"] = resp.body;
    }
  }
  return ok(JSON.stringify(result));
}

/**
 * Extract fields from a JSON string using JSONPath (RFC 9535). Returns
 * undefined if the body is not valid JSON (caller falls back to returning
 * the raw body). Each path is evaluated via jsonpath-plus; a missing path
 * yields null, a single-match path yields the bare value (backward compat
 * with the old dot-path behavior), and a multi-match path (wildcards [*],
 * indices [N], recursive descent ..) yields an array of matches.
 *
 * Upgraded from a hand-rolled dot-path walker that could not descend into
 * arrays — HuaweiCloud APIs return arrays (resource lists, bill details),
 * so account_balances[*].amount must work. jsonpath-plus is the RFC 9535
 * reference implementation for JS.
 */
export function extractFields(
  jsonBody: string,
  fields: string[],
): Array<{ path: string; value: unknown }> | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonBody);
  } catch {
    return undefined;
  }
  return fields.map((path) => {
    // resultType:'value' (the default) returns a plain array of matched
    // values. The library's TS type is overly broad (JSONPathClass), so we
    // narrow via unknown — runtime is always an array for 'value'.
    const result = JSONPath({ path, json: parsed as object, resultType: "value" }) as unknown as unknown[];
    // Unwrap single-result paths to a bare value for backward compat with
    // the old dot-path behavior. Paths with wildcards ([*], [N], ..) keep
    // the array — that's the whole point.
    const value = result.length === 0
      ? null
      : result.length === 1
        ? result[0]
        : result;
    return { path, value };
  });
}
