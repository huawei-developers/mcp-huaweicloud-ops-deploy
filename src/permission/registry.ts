/**
 * Read-only registry — answers "is this request a query?" for arbitrary URLs.
 *
 * `openapi_request` takes a method and a URL straight from the model, so the
 * only way to know whether a call mutates cloud state is to look the URL up
 * in a table built from the API catalog. This module owns that lookup.
 *
 * ## The decision
 *
 * {@link isReadOnlyPermitted} returns true when a request may proceed in
 * read-only mode. Its rules, in order:
 *
 *   - `GET` and `HEAD` are queries. No lookup. HTTP defines them as safe
 *     methods, and the metadata does not cover every service the server can
 *     reach — OBS has no entry at all, so a lookup would deny an object
 *     download. Method alone gets OBS right: its reads are GET, its mutations
 *     are PUT/POST/DELETE.
 *   - Anything else is looked up in the registry, keyed by method and the
 *     host's first label. A match means the operation is a known query.
 *   - No match means deny. The default is deny, so an operation the registry
 *     has never heard of — a new API, a service that is not in the catalog, a
 *     typo — cannot become a permitted mutation.
 *
 * The asymmetry is the point: a false deny costs one rejected query, which
 * the operator can see and fix; a false permit is an unasked-for change to
 * production infrastructure.
 *
 * ## Known coverage gap: the table covers less than the catalog
 *
 * The registry is built from the hcloud CLI's cached APIExplorer metadata. That
 * cache is not the whole catalog. Measured 2026-10-07 by calling
 * `ListProductsV4` / `ListApis` on `apiexplorer.cn-north-4.myhuaweicloud.com`:
 *
 *     APIExplorer catalog   310 products, 221 with a non-zero api_count
 *                           api_count totals 18,693
 *     hcloud cache          129 services, 11,439 API files
 *     not in the cache       92 products, 5,789 APIs
 *
 * The bulk of the shortfall is HCS and ManageOne services (Huawei Cloud Stack),
 * which are not public-cloud services. The rest is public: IDT (930 APIs),
 * MetaStudio (293), AgentArts (247), eiHealth (223), WorkspaceApp (174),
 * IEF (111), OBS (94 by the catalog's count), and others.
 *
 * Consequence: for a service absent from the table, every non-GET/HEAD request
 * is refused in read-only mode, including reads that would be safe. The
 * direction is the intended one — a legitimate query is rejected rather than a
 * mutation admitted — so the cost is user-visible friction, not exposure.
 *
 * OBS deserves separate mention because its case is different. The catalog
 * lists it with 94 APIs, but `ListApis?productshort=OBS` returns zero entries,
 * so there is no per-operation metadata to build patterns from regardless of
 * what else is fetched. OBS is the one service the GET/HEAD rule carries
 * entirely on its own.
 *
 * The cache was written as a single batch (all 129 directories share one
 * mtime), and the catalog figures above come from live APIExplorer responses,
 * not from the cache. A burst of `ListApis` calls during measurement returned
 * HTTP 429.
 *
 * ## Why the host's first label is the service key
 *
 * The service directory in the metadata is not recoverable from a request —
 * only method and URL are. Host labels are also coarser than directories, and
 * several directories share one label (`kafka`, `rabbitmq`, and `rocketmq` all
 * serve from `dms.*`; `eip` serves from `vpc.*`). Keying on the label is both
 * derivable and safer: those services collapse into one bucket, so a path
 * segment they share can never be resolved to the wrong one.
 *
 * ## Loading
 *
 * The artifact is read once, lazily, on the first lookup, and cached for the
 * process lifetime. Patterns are compiled once at load. A missing or
 * unreadable artifact does not break the server: the registry reports itself
 * unavailable and every non-GET/HEAD request is denied — read-only mode fails
 * closed rather than silently permitting writes.
 *
 * @module permission/registry
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Why a request was permitted or denied. */
export type Decision =
  | { readonly allowed: true; readonly reason: "safe-method" | "registry-match" }
  | { readonly allowed: false; readonly reason: "registry-miss" | "registry-unavailable" };

/** The artifact shape, as written by `scripts/build-permission-registry.ts`. */
interface RegistryArtifact {
  readonly version: number;
  readonly methods: Record<string, Record<string, readonly string[]>>;
}

/** Compiled registry: method -> host label -> patterns. */
type Compiled = Map<string, Map<string, RegExp[]>>;

/** Lazily-loaded compiled registry, or the failure that prevented loading. */
let compiled: Compiled | undefined;
let loadError: string | undefined;
/** Number of patterns loaded, for diagnostics. */
let patternCount = 0;

/**
 * Locate the artifact next to the compiled output.
 *
 * Mirrors `tools/examples.ts`: the build copies `src/data/*` to `dist/data/`,
 * so the path is resolved relative to this module rather than the cwd, which
 * the MCP client controls.
 *
 * @returns absolute path to the registry artifact.
 */
function artifactPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // dist/permission/registry.js -> dist/data/permission-registry.json
  return join(here, "..", "data", "permission-registry.json");
}

/**
 * Load and compile the registry.
 *
 * Called once. A failure is recorded, not thrown: the caller denies, which is
 * the correct behaviour for an unusable registry in read-only mode.
 *
 * @returns the compiled registry, or `undefined` when it could not be loaded.
 */
function load(): Compiled | undefined {
  if (compiled !== undefined) return compiled;
  if (loadError !== undefined) return undefined;

  let raw: string;
  try {
    raw = readFileSync(artifactPath(), "utf8");
  } catch (err) {
    loadError = `permission registry not found at ${artifactPath()} (${
      err instanceof Error ? err.message : String(err)
    }) — run \`npm run build-permission-registry\``;
    return undefined;
  }

  let parsed: RegistryArtifact;
  try {
    parsed = JSON.parse(raw) as RegistryArtifact;
  } catch (err) {
    loadError = `permission registry is not valid JSON: ${err instanceof Error ? err.message : String(err)}`;
    return undefined;
  }

  if (parsed === null || typeof parsed !== "object" || parsed.methods === null || typeof parsed.methods !== "object") {
    loadError = "permission registry has an unexpected shape (no `methods`)";
    return undefined;
  }

  const result: Compiled = new Map();
  let count = 0;
  for (const [method, labels] of Object.entries(parsed.methods)) {
    const byLabel = new Map<string, RegExp[]>();
    for (const [label, sources] of Object.entries(labels)) {
      const patterns: RegExp[] = [];
      for (const source of sources) {
        try {
          patterns.push(new RegExp(source));
        } catch (err) {
          loadError = `permission registry pattern ${JSON.stringify(source)} did not compile: ${
            err instanceof Error ? err.message : String(err)
          }`;
          return undefined;
        }
      }
      byLabel.set(label, patterns);
      count += patterns.length;
    }
    result.set(method, byLabel);
  }

  compiled = result;
  patternCount = count;
  return compiled;
}

/**
 * Host's first label — the registry's service key.
 *
 * The edition suffix is not part of a service's identity. `bss` and `bss-intl`
 * are the China-site and international-site endpoints of one product, and
 * whether an operation reads or writes does not change with the site, so both
 * normalize to the same key. The cached metadata carries only one edition for
 * most such services (it holds `bss-intl` and no `bss`), which is why the
 * normalization matters: without it a request to the other edition lands in a
 * bucket that does not exist.
 *
 * `scripts/build-permission-registry.ts` applies the same rule, so the
 * artifact's buckets and the runtime's lookups agree.
 *
 * The limit of what this rests on: the metadata cannot confirm that an
 * operation registered under one edition exists and behaves the same under the
 * other. APIExplorer returns no per-operation detail for the products where
 * this matters most (`ListApis?productshort=BSS` and `=BSSINTL` both answer
 * with zero entries), and `smn` against `smnglobal` shows the two editions can
 * carry entirely different operation sets — disjoint, 44 against 2. Those
 * cases overlap in nothing, so nothing is admitted twice; but the general
 * claim is a statement about how HuaweiCloud versions these products, not
 * something this repository measured.
 *
 * @param hostname - URL hostname.
 * @returns the first label with any edition suffix removed.
 */
function serviceLabel(hostname: string): string {
  const label = hostname.split(".")[0] ?? hostname;
  if (label === "") return hostname;
  for (const suffix of EDITION_SUFFIXES) {
    if (label.endsWith(suffix) && label.length > suffix.length) {
      return label.slice(0, -suffix.length);
    }
  }
  return label;
}

/** Suffixes naming a service's international or global endpoint. */
const EDITION_SUFFIXES = ["-intl", "-global"] as const;

/** Methods admitted without a lookup — HTTP defines them as safe. */
const SAFE_METHODS = new Set(["GET", "HEAD"]);

/**
 * Decide whether a request may proceed in read-only mode.
 *
 * @param method - HTTP method, any case.
 * @param url - the full request URL.
 * @returns the decision, with the reason for it.
 */
export function isReadOnlyPermitted(method: string, url: URL): Decision {
  const upper = method.toUpperCase();
  if (SAFE_METHODS.has(upper)) return { allowed: true, reason: "safe-method" };

  const registry = load();
  if (registry === undefined) return { allowed: false, reason: "registry-unavailable" };

  const patterns = registry.get(upper)?.get(serviceLabel(url.hostname));
  if (patterns === undefined || patterns.length === 0) {
    return { allowed: false, reason: "registry-miss" };
  }

  for (const pattern of patterns) {
    // The patterns are anchored, so this asks "is this exactly the registered
    // query", never "does this URL live under a registered prefix".
    if (pattern.test(url.pathname)) return { allowed: true, reason: "registry-match" };
  }
  return { allowed: false, reason: "registry-miss" };
}

/**
 * Whether the registry loaded successfully.
 *
 * Reported once at startup so an operator learns immediately that read-only
 * mode is denying everything, rather than discovering it from a tool result.
 *
 * @returns `undefined` when healthy, otherwise the load failure.
 */
export function registryStatus(): { readonly patterns: number; readonly error?: string } {
  const registry = load();
  if (registry === undefined) return { patterns: 0, ...(loadError === undefined ? {} : { error: loadError }) };
  return { patterns: patternCount };
}

/** Drop the cache so the next lookup reloads. Used by tests. */
export function resetRegistry(): void {
  compiled = undefined;
  loadError = undefined;
  patternCount = 0;
}