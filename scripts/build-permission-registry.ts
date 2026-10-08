/**
 * Build-time script: compile the read-only permission registry.
 *
 * Source: the hcloud CLI's locally cached APIExplorer metadata
 * (`~/.hcloud/metaOrigin/template/<service>/*_origin_cn.yaml` — the files
 * carry a .yaml suffix but hold JSON). Each file is one API operation and
 * carries `host`, `method`, and `paths` — everything the registry needs.
 *
 * ## What the registry is for
 *
 * `openapi_request` accepts an arbitrary method + URL from the model, so a
 * read-only deployment needs a way to tell a query from a mutation before
 * signing the request. This script distils the metadata into the smallest
 * table that answers exactly that question, and no more.
 *
 * ## Why only the READ set is stored
 *
 * The runtime defaults to DENY: a request is permitted only when it matches a
 * stored pattern. So storing the write set would be dead weight — an absent
 * pattern and a stored "write" pattern have identical effect. Storing only
 * reads shrinks the artifact roughly 10x (6186 entries -> 620) and collapses
 * the lookup to one set-membership question, which is much harder to get
 * wrong than a three-valued one.
 *
 * The cost is that a denial cannot distinguish "known write" from "not in the
 * registry". The runtime logs that distinction to stderr (never to the model),
 * which is where a registry gap needs to surface anyway.
 *
 * ## Why the key is (method, host-label, path), not cloud service
 *
 * The service directory name is NOT available at runtime — a request carries
 * only its method and URL. Deriving the service from the URL gives the host's
 * first label, and those labels are coarser than the directories:
 *
 *     dms  <- kafka, rabbitmq, rocketmq      kms  <- csms, kms, kps
 *     vpc  <- eip, vpc                       rfs  <- aos, rfs
 *
 * Grouping by that label rather than by directory is therefore both
 * derivable at runtime and strictly safer: the three DMS services collapse
 * into one bucket, so a shared path segment can no longer be resolved to the
 * wrong service.
 *
 * ## GET and HEAD are not in the registry
 *
 * The gate admits GET/HEAD unconditionally, before consulting the table. That
 * is deliberate: it closes a gap that no amount of table-completeness would,
 * because APIExplorer carries no per-operation metadata for OBS. The catalog
 * lists OBS with 94 APIs, but `ListApis?productshort=OBS` returns zero
 * entries, and no bucket-style host appears in the metadata. A registry lookup
 * would therefore fail closed on every OBS call — including a plain object
 * download. Because OBS reads are GET/HEAD and its mutations are
 * PUT/POST/DELETE, the method rule covers OBS correctly with no special case.
 *
 * It also avoids a class of heuristic error. 17 GET operations carry a
 * write-looking name while being reads (`RunQueryAudioModerationJob` —
 * "查询音频内容审核作业"), so verb rules are simply not applied to GET.
 *
 * PUT and PATCH are likewise decided by method alone, in the other direction:
 * they are always mutations (see `classify`).
 *
 * ## What this builder covers, and what it does not
 *
 * Input is the hcloud metadata cache, and that cache is a subset of the
 * catalog rather than a mirror of it. Measured 2026-10-07 against live
 * APIExplorer: the catalog holds 310 products totalling 18,693 APIs, of which
 * 221 products have a non-zero `api_count`; the cache holds 129 services and
 * 11,439 API files. 92 products (5,789 APIs) are in one and not the other —
 * mostly HCS and ManageOne services (Huawei Cloud Stack, not public cloud),
 * plus public services such as IDT, MetaStudio, AgentArts, eiHealth,
 * WorkspaceApp and IEF.
 * Operations belonging to those services have no patterns here, and in
 * read-only mode a non-GET request against them is refused.
 *
 * The cache was written as a single batch — all 129 directories share one
 * mtime — so this is the shape of one download, not an accumulation of
 * earlier ones. Collecting the live catalog during measurement earned HTTP 429
 * from a burst of `ListApis` calls.
 *
 * The figures above come from live APIExplorer responses, not from the cache.
 *
 * ## Determinism
 *
 * The artifact must be a pure function of the metadata: same input, byte-identical
 * output. Everything is sorted, no timestamp is embedded, and `--check`
 * regenerates and diffs. This matters because the classification below is
 * heuristic and will drift as the rules are edited — a silent reshuffle of
 * which operations are permitted is exactly the kind of change that must show
 * up as a reviewable diff instead.
 *
 * Run:    npm run build-permission-registry
 * Verify: npm run build-permission-registry -- --check
 * Output: src/data/permission-registry.json
 */

import { readFileSync, readdirSync, writeFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** The artifact layout version. Bump when the shape changes. */
const ARTIFACT_VERSION = 1;

/** Where the hcloud CLI caches APIExplorer metadata. */
const DEFAULT_METADATA_DIR = join(homedir(), ".hcloud", "metaOrigin", "template");

/** Refuse to write an artifact built from implausibly little input. */
const MIN_EXPECTED_ENTRIES = 5000;

/**
 * Service-name prefixes stripped from operation names before verb matching.
 *
 * Names like `BatchCreateServerTags` or `KeystoneCreateUser` describe the same
 * action as their unprefixed form; without stripping, the verb sits behind a
 * noun and the name falls through to the summary heuristic. The unprefixed
 * name is tried only when something follows the prefix.
 */
const SERVICE_PREFIXES = ["batch", "keystone", "neutron", "cinder", "nova", "glance", "openstack"];

/** Leading verbs marking a query. */
const READ_VERBS = [
  "list", "show", "get", "query", "describe", "count", "detail", "statistic",
  "search", "find", "check", "verify", "validate", "export", "download",
  "preview", "generate",
];

/** Leading verbs marking a mutation. */
const WRITE_VERBS = [
  "create", "update", "delete", "modify", "add", "remove", "attach", "detach",
  "set", "reset", "enable", "disable", "start", "stop", "resize", "reboot",
  "execute", "run", "cancel", "bind", "unbind", "authorize", "rotate",
  "register", "import", "restore", "migrate", "copy", "clone", "publish",
  "sync", "associate", "disassociate",
];

/** Chinese summary markers for a query. */
const READ_SUMMARY_MARKERS = [
  "查询", "获取", "列举", "列出", "查看", "检索", "搜索", "导出", "下载",
  "统计", "校验", "检查", "预览",
];

/** Chinese summary markers for a mutation. */
const WRITE_SUMMARY_MARKERS = [
  "创建", "删除", "更新", "修改", "添加", "移除", "绑定", "解绑", "启动",
  "停止", "重启", "执行", "重置", "变更", "扩容", "缩容", "导入", "注册",
  "授权", "取消", "恢复", "迁移",
];

/** One operation, reduced to the fields classification needs. */
interface Operation {
  /** Service directory the entry came from (diagnostics only). */
  readonly service: string;
  /** HTTP method, upper-cased. */
  readonly method: string;
  /** Endpoint host, e.g. `ecs.cn-north-4.myhuaweicloud.com`. */
  readonly host: string;
  /** Request path templates. */
  readonly paths: readonly string[];
  /** Operation name, e.g. `ListCloudServers`. */
  readonly name: string;
  /** Human summary (Chinese in the cn metadata). */
  readonly summary: string;
  /** Value of `x-access-level` when the metadata carries one. */
  readonly accessLevel: string | undefined;
}

/**
 * Read the metadata directory.
 *
 * Every file is parsed as JSON. Files that fail to parse are counted, not
 * thrown on: the directory holds both `_origin_cn` and `_origin_en` variants
 * plus `apis_origin_*.json` indexes, and only the per-operation files are
 * wanted. The caller checks the overall yield, so a format change that makes
 * every file unparseable surfaces as a hard failure rather than an empty
 * registry.
 *
 * @param dir - metadata directory.
 * @returns the operations found, and how many files failed to parse.
 */
function loadOperations(dir: string): { operations: Operation[]; unparsed: number } {
  const operations: Operation[] = [];
  let unparsed = 0;

  for (const service of readdirSync(dir)) {
    const serviceDir = join(dir, service);
    let files: string[];
    try {
      if (!statSync(serviceDir).isDirectory()) continue;
      files = readdirSync(serviceDir);
    } catch {
      continue;
    }

    for (const file of files) {
      // The cn variant is the authority: its summaries and names drive the
      // summary heuristic. The en variant would double-count every operation.
      if (!file.endsWith("_origin_cn.yaml")) continue;

      let raw: unknown;
      try {
        raw = JSON.parse(readFileSync(join(serviceDir, file), "utf8"));
      } catch {
        unparsed += 1;
        continue;
      }

      if (raw === null || typeof raw !== "object") continue;
      const entry = raw as Record<string, unknown>;
      const host = entry["host"];
      const method = entry["method"];
      const paths = entry["paths"];
      if (typeof host !== "string" || typeof method !== "string") continue;
      if (paths === null || typeof paths !== "object") continue;

      // x-access-level is not present in current metadata (checked: zero
      // occurrences across all 129 services) but is honoured when a future
      // drop carries it — an authoritative signal beats a name guess.
      const vendor = entry["vendor_extensions"];
      const accessLevel =
        (typeof entry["x-access-level"] === "string" ? entry["x-access-level"] : undefined) ??
        (vendor !== null && typeof vendor === "object"
          ? (vendor as Record<string, unknown>)["x-access-level"]
          : undefined);
      if (accessLevel !== undefined && typeof accessLevel !== "string") continue;
      const level: string | undefined = typeof accessLevel === "string" ? accessLevel : undefined;

      operations.push({
        service,
        method: method.toUpperCase(),
        host,
        paths: Object.keys(paths as Record<string, unknown>),
        name: typeof entry["name"] === "string" ? entry["name"] : "",
        summary: typeof entry["summary"] === "string" ? entry["summary"] : "",
        accessLevel: level,
      });
    }
  }

  return { operations, unparsed };
}

/**
 * Classify one operation as a query or a mutation.
 *
 * Order of authority, strongest first:
 *
 *   1. The HTTP method, at both extremes. PUT and PATCH are always mutations:
 *      they carry replace/patch semantics, so an operation that is genuinely a
 *      query has no business using them. This is not hypothetical — the two
 *      operations the name heuristic got wrong in the dangerous direction were
 *      both PUTs whose names read as queries while their summaries said
 *      otherwise (`ShowHasPipeline` — "修改被流水线引用的仓库状态",
 *      `ListTemplatesTwo` — "设置仓库是公开状态还是私有状态"). A name-based
 *      rule cannot catch those, and being wrong toward "read" is the one
 *      failure this registry must not have.
 *   2. `x-access-level`, when present.
 *   3. The leading verb of the name, after stripping a service prefix.
 *      Longest match wins, which is what separates `ResetPassword` (write)
 *      from a hypothetical `ResetPasswordQuery`. When a read verb and a write
 *      verb match at equal length the operation is called a mutation — the tie
 *      is broken toward the safer answer.
 *   4. Chinese summary markers, consulted only when no verb matched at all.
 *      The summary is deliberately NOT allowed to override a matched verb: a
 *      leading-marker variant of this rule was tried and it admitted
 *      `CreateInstanceTempCredential` ("获取临时凭据") and five IAM token
 *      creations, because "获取" describes the caller receiving a freshly
 *      minted credential. Summaries describe intent; verbs describe effect.
 *   5. Anything unresolved is a mutation.
 *
 * Step 5 is where the heuristic's misses land, and it is a deny by
 * construction. The residual bucket is dominated by genuine mutations
 * (`SendMessage`, `UploadAttachments`, `replaceAppsV1NamespacedDeployment`),
 * so the conservative answer is also usually the correct one.
 *
 * Audited against the current metadata: the read set is 615 operations, all
 * POST, of which 40 are resolved by summary. One of those 40 is arguably wrong
 * (`hss RecordUserViewVulTask` stamps a "last viewed" timestamp — a mutation
 * that does not touch a cloud resource), so the error rate in the dangerous
 * direction is 1 in 615, and the error is inert.
 *
 * @param operation - the operation to classify.
 * @returns `'read'` for a query, `'write'` for a mutation.
 */
function classify(operation: Operation): "read" | "write" {
  // Replace-semantics methods are never queries. See the note above.
  if (operation.method === "PUT" || operation.method === "PATCH") return "write";

  if (operation.accessLevel !== undefined) {
    const level = operation.accessLevel.toLowerCase();
    if (level.includes("readonly")) return "read";
    if (level.includes("readwrite") || level.includes("write")) return "write";
    if (level.includes("list")) return "read";
  }

  let name = operation.name.toLowerCase();
  for (const prefix of SERVICE_PREFIXES) {
    if (name.startsWith(prefix) && name.length > prefix.length) {
      const rest = name.slice(prefix.length);
      // Only strip when a real word follows, so `batch` (as in "batch of
      // items") is not mistaken for the Batch service prefix.
      const first = rest[0] ?? "";
      if (first !== "" && (first === first.toUpperCase() || !/[a-z]/.test(first))) {
        name = rest.replace(/^_+/, "");
        break;
      }
    }
  }

  const readVerb = longestMatch(name, READ_VERBS);
  const writeVerb = longestMatch(name, WRITE_VERBS);
  if (readVerb !== undefined && writeVerb !== undefined) {
    if (writeVerb.length >= readVerb.length) return "write";
    return "read";
  }
  if (readVerb !== undefined) return "read";
  if (writeVerb !== undefined) return "write";

  const reads = READ_SUMMARY_MARKERS.some((marker) => operation.summary.includes(marker));
  const writes = WRITE_SUMMARY_MARKERS.some((marker) => operation.summary.includes(marker));
  if (writes && !reads) return "write";
  if (reads && !writes) return "read";

  return "write";
}

/**
 * Longest verb in `verbs` that `text` starts with, or `undefined`.
 *
 * @param text - lower-cased operation name.
 * @param verbs - candidate verbs.
 * @returns the longest match.
 */
function longestMatch(text: string, verbs: readonly string[]): string | undefined {
  let best: string | undefined;
  for (const verb of verbs) {
    if (text.startsWith(verb) && (best === undefined || verb.length > best.length)) best = verb;
  }
  return best;
}

/** Suffixes naming a service's international or global endpoint. */
const EDITION_SUFFIXES = ["-intl", "-global"] as const;

/**
 * Host's first label — the runtime-derivable service key, with the edition
 * suffix removed.
 *
 * `bss` and `bss-intl` are one product's China-site and international-site
 * endpoints, and read-versus-write does not change with the site, so they key
 * to the same bucket. This matters because the cache carries only one edition
 * for most such services: it holds `bss-intl` and no `bss` at all, so without
 * normalization a request to the other edition would find no bucket.
 *
 * `src/permission/registry.ts` strips the same suffixes at lookup time. The
 * two must agree — normalizing on one side only would leave the artifact keyed
 * `bss-intl` while the runtime asks for `bss`.
 *
 * @param host - endpoint host from the metadata.
 * @returns the bucket key.
 */
function hostLabel(host: string): string {
  const label = host.split(".")[0] ?? host;
  if (label === "") return host;
  for (const suffix of EDITION_SUFFIXES) {
    if (label.endsWith(suffix) && label.length > suffix.length) {
      return label.slice(0, -suffix.length);
    }
  }
  return label;
}

/**
 * Turn a path template into an anchored regex.
 *
 * `{param}` becomes `[^/]+?` — non-greedy and unable to cross a `/`, so
 * `/v1/{project_id}/cloudservers` cannot swallow a following path segment.
 * Everything else is escaped literally. The pattern is anchored at both ends:
 * the table answers "is this exactly the operation", not "does this URL live
 * under that prefix", because a prefix match would let an unregistered
 * mutation ride on a registered read path.
 *
 * @param path - path template from the metadata.
 * @returns anchored regex source.
 */
function toRegexSource(path: string): string {
  let source = "";
  for (const part of path.split(/(\{[^}]+\})/)) {
    if (part === "") continue;
    const isPlaceholder = part.startsWith("{") && part.endsWith("}");
    source += isPlaceholder ? "[^/]+?" : escapeRegex(part);
  }
  return `^${source}$`;
}

/**
 * Escape regex metacharacters in a literal path segment.
 *
 * @param text - literal text.
 * @returns text safe to embed in a regex.
 */
function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The artifact shape written to disk. */
interface RegistryArtifact {
  readonly version: number;
  readonly source: string;
  readonly note: string;
  /** method -> host label -> read-path regexes. */
  readonly methods: Record<string, Record<string, string[]>>;
}

/**
 * Build the artifact from the metadata directory.
 *
 * Only non-GET/HEAD operations are considered (the gate admits those
 * unconditionally — see the module doc), and only the reads among them are
 * stored, because the runtime denies by default.
 *
 * A path that is a read in one operation and a mutation in another is dropped
 * from the read set rather than kept: the two entries are indistinguishable at
 * runtime, so admitting it would admit the mutation too. Eleven such paths
 * exist across the metadata, several of them on `/action` endpoints that
 * really do both.
 *
 * @param dir - metadata directory.
 * @returns the artifact, plus counters for the build report.
 */
function build(dir: string): { artifact: RegistryArtifact; report: Record<string, number> } {
  const { operations, unparsed } = loadOperations(dir);
  if (operations.length < MIN_EXPECTED_ENTRIES) {
    throw new Error(
      `only ${operations.length} operations parsed from ${dir} (expected at least ` +
        `${MIN_EXPECTED_ENTRIES}) — the metadata format may have changed; refusing to ` +
        `write a registry that would deny nearly everything`,
    );
  }

  /** regex -> "read" | "write", for the write-wins conflict rule. */
  const levels = new Map<string, "read" | "write">();
  /** method -> label -> regex, reads only. */
  const reads = new Map<string, Map<string, Set<string>>>();
  const report: Record<string, number> = {
    operations: operations.length,
    unparsedFiles: unparsed,
    skippedGetHead: 0,
    read: 0,
    write: 0,
    conflictDropped: 0,
  };

  for (const operation of operations) {
    // GET/HEAD are admitted by method at the gate, before any lookup.
    if (operation.method === "GET" || operation.method === "HEAD") {
      report["skippedGetHead"] = (report["skippedGetHead"] ?? 0) + 1;
      continue;
    }

    const level = classify(operation);
    report[level] = (report[level] ?? 0) + 1;
    const label = hostLabel(operation.host);

    for (const path of operation.paths) {
      const source = toRegexSource(path);
      const seen = levels.get(source);
      if (seen !== undefined && seen !== level) {
        // Same regex, both levels: keep the mutation so the read cannot admit it.
        levels.set(source, "write");
        continue;
      }
      levels.set(source, level);
    }

    if (level !== "read") continue;
    let byLabel = reads.get(operation.method);
    if (byLabel === undefined) {
      byLabel = new Map();
      reads.set(operation.method, byLabel);
    }
    let patterns = byLabel.get(label);
    if (patterns === undefined) {
      patterns = new Set();
      byLabel.set(label, patterns);
    }
    for (const path of operation.paths) patterns.add(toRegexSource(path));
  }

  // Drop conflicted reads last, so the write-wins rule sees every operation
  // before any pattern is admitted.
  const methods: Record<string, Record<string, string[]>> = {};
  for (const method of [...reads.keys()].sort()) {
    const byLabel = reads.get(method);
    if (byLabel === undefined) continue;
    const labels: Record<string, string[]> = {};
    for (const label of [...byLabel.keys()].sort()) {
      const patterns = [...(byLabel.get(label) ?? [])]
        .filter((pattern) => {
          if (levels.get(pattern) === "write") {
            report["conflictDropped"] = (report["conflictDropped"] ?? 0) + 1;
            return false;
          }
          return true;
        })
        .sort();
      if (patterns.length > 0) labels[label] = patterns;
    }
    if (Object.keys(labels).length > 0) methods[method] = labels;
  }

  const artifact: RegistryArtifact = {
    version: ARTIFACT_VERSION,
    source: "hcloud CLI APIExplorer metadata (~/.hcloud/metaOrigin/template)",
    note:
      "Read-only allow-list: method -> host-label -> anchored path regexes for " +
      "operations classified as queries. GET/HEAD are admitted by method and are " +
      "not listed. Any non-GET request not matched here is denied. Regenerate with " +
      "`npm run build-permission-registry`.",
    methods,
  };
  return { artifact, report };
}

/**
 * Entry point.
 *
 * With `--check`, regenerate and compare against the file on disk instead of
 * writing, exiting non-zero on any difference.
 */
function main(): void {
  const check = process.argv.includes("--check");
  const dir = process.env["HCLOUD_METADATA_DIR"] ?? DEFAULT_METADATA_DIR;
  const output = new URL("../src/data/permission-registry.json", import.meta.url);

  const { artifact, report } = build(dir);
  const rendered = `${JSON.stringify(artifact, null, 0)}\n`;

  const entries = Object.values(artifact.methods).reduce(
    (total, labels) =>
      total + Object.values(labels).reduce((sum, patterns) => sum + patterns.length, 0),
    0,
  );

  console.log(`source: ${dir}`);
  for (const [key, value] of Object.entries(report)) console.log(`  ${key}: ${value}`);
  console.log(`  allowed patterns: ${entries}`);
  console.log(`  artifact: ${(rendered.length / 1024).toFixed(1)} KB`);

  if (check) {
    let existing = "";
    try {
      existing = readFileSync(output, "utf8");
    } catch {
      console.error("check failed: src/data/permission-registry.json is missing");
      process.exit(1);
    }
    if (existing !== rendered) {
      console.error(
        "check failed: the registry on disk differs from a fresh build.\n" +
          "Run `npm run build-permission-registry` and review the diff — the " +
          "classification rules changed which operations are permitted.",
      );
      process.exit(1);
    }
    console.log("check ok: registry matches the metadata and the current rules");
    return;
  }

  writeFileSync(output, rendered);
  console.log("wrote src/data/permission-registry.json");
}

main();