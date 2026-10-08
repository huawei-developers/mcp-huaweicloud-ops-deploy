/**
 * Credential storage — keychain first, machine-fingerprint file fallback.
 *
 * DESIGN.zh.md §5.2: OS keychain (macOS Keychain / Windows DPAPI / Linux
 * Secret Service) is preferred. When unavailable (headless Linux, Docker,
 * no keyring daemon), fall back to a machine-fingerprint-derived
 * AES-256-GCM encrypted file in ~/.huaweicloud-ops-deploy/.
 *
 * ## Scoping
 *
 * Both layers are namespaced by a credential scope (see `./scope.ts`), so
 * several MCP clients on one machine do not overwrite each other. The
 * environment variable channel below is a per-client override on top of that;
 * the scope is what separates clients that never set it.
 *
 * STS (security_token) credentials are NEVER persisted — they expire. They
 * live only in the in-memory session cache for the process lifetime.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";

import { tryKeychainDelete, tryKeychainGet, tryKeychainSet } from "./keychain.js";
import { fingerprintDecrypt, fingerprintEncrypt } from "./fingerprint.js";
import { SCOPE_ENV, credentialsFileName, keychainAccount, parseScope } from "./scope.js";

/**
 * Keychain service. Stable across scopes — the account carries the separation.
 *
 * Exported for the test that pins it: the service name is a persistence key,
 * and renaming it would orphan every stored entry while looking like a
 * harmless constant change. Nothing in `src/` reads it besides this module.
 */
export const SERVICE = "huaweicloud-ops-deploy";

/**
 * This process's credential scope.
 *
 * Parsed at module load, so an invalid value fails the process at startup
 * rather than at the first tool call — a mistyped scope must not look like
 * "not authenticated" later. One process serves one client, so one scope per
 * process is the whole model; the two caches below stay correct without
 * carrying a scope key.
 */
export const SCOPE = parseScope(process.env[SCOPE_ENV]);

const ACCOUNT = keychainAccount(SCOPE);
const CREDS_DIR = join(homedir(), ".huaweicloud-ops-deploy");
const CREDS_FILE = join(CREDS_DIR, credentialsFileName(SCOPE));

/**
 * In-memory session credentials (STS / not persisted).
 *
 * Carries the optional account identity (from IAM verification) alongside
 * the creds — permanent creds persist account to keychain/file, STS keeps
 * it in memory only for the process lifetime.
 */
interface SessionCredentials extends Credentials {
  account?: StoredAccount | undefined;
}

let sessionCredentials: SessionCredentials | null = null;

export interface Credentials {
  ak: string;
  sk: string;
  region: string;
  security_token?: string | undefined;
}

/**
 * Account identity resolved from IAM verification (auth/iam.ts).
 *
 * Stored alongside the credentials (same keychain payload / same fallback
 * file) because it shares the credential's lifecycle — one AK/SK maps to
 * exactly one account. backfillAccount reads this when a terraform tool
 * touches a deployment, without needing to re-query IAM.
 *
 * Persisted payload: { ak, sk, region, account_id, account_name }
 *   — account_* fields are optional for backward compat with payloads
 *     written before verification was wired.
 */
export interface StoredAccount {
  account_id: string;
  account_name: string;
}

/**
 * Parsed form of the persisted payload — credentials + account in one read.
 *
 * The on-disk/keychain payload is a single JSON blob; parsing it once gives
 * both the credentials (loadCredentials) and the account (loadAccount).
 * Without this cache, runTerraform would hit the keychain twice per call
 * (once in resolveTerraformEnv → loadCredentials, once in loadAccount) —
 * each is a D-Bus round-trip that can take 50-100ms on Linux Secret Service.
 *
 * Lifecycle:
 *   - Filled lazily by loadPersistedPayload on first read.
 *   - Invalidated by saveCredentials (a re-auth replaces the payload).
 *   - STS credentials bypass it entirely (sessionCredentials path).
 */
interface PersistedPayload {
  credentials: Credentials;
  account: StoredAccount | null;
}

let persistedCache: PersistedPayload | null = null;

/**
 * Save credentials. STS → memory only. Permanent → keychain + memory.
 *
 * sessionCredentials is always set so this process uses the just-verified
 * creds + account for the rest of its lifetime.
 */
export async function saveCredentials(creds: Credentials, account?: StoredAccount): Promise<void> {
  sessionCredentials = { ...creds, account };
  if (creds.security_token) return; // STS: memory only.
  const payload = JSON.stringify({
    ak: creds.ak,
    sk: creds.sk,
    region: creds.region,
    account_id: account?.account_id,
    account_name: account?.account_name,
  });
  const ok = await tryKeychainSet(SERVICE, ACCOUNT, payload);
  if (!ok) {
    await mkdir(CREDS_DIR, { recursive: true });
    const encrypted = await fingerprintEncrypt(payload);
    await writeFile(CREDS_FILE, encrypted);
  }
  persistedCache = null;
}

/**
 * Clear this process's scope's credentials: session memory, the keychain
 * entry, and the fallback file.
 *
 * STS credentials are session-only, so they are cleared by nulling the
 * session — nothing persisted to remove. Permanent credentials are removed
 * from the keychain (if reachable) and the fallback file (if it exists); a
 * missing file is not an error — the scope may never have written one.
 *
 * Env vars (`HW_ACCESS_KEY` etc.) are set by the MCP client in its spawn
 * config, which this process cannot reach. When they are present the caller
 * is told so: a reset does not log the client out when the client carries its
 * own credentials, and that must be visible rather than look like a silent
 * no-op. The return value never carries a credential.
 *
 * Idempotent: a second reset on an already-cleared scope finds nothing to
 * remove and reports the same state.
 *
 * @returns what was cleared and whether env vars still supply credentials.
 */
export interface ClearResult {
  /** The scope whose stored credentials were removed. */
  scope: string;
  /** True if the keychain was reached and the delete ran (entry present or not). */
  keychain: boolean;
  /** True if the fallback file was deleted, or was already absent. */
  file: boolean;
  /**
   * True if `HW_ACCESS_KEY`/`HW_SECRET_KEY`/`HW_REGION_NAME` are set in this
   * process's environment. When true, the client still authenticates from env
   * after reset — the reset cleared only the persisted and session layers.
   */
  env_active: boolean;
}

export async function clearCredentials(): Promise<ClearResult> {
  // Drop in-memory state first so a concurrent loadCredentials in this process
  // cannot repopulate from the session while the persisted layers are being
  // removed.
  sessionCredentials = null;
  persistedCache = null;

  // Keychain — best-effort. `false` means unavailable (headless, no D-Bus);
  // the caller still owns the fallback file.
  const keychainDeleted = await tryKeychainDelete(SERVICE, ACCOUNT).catch(() => false);

  // Fallback file — a missing file is the cleared state, not a failure.
  let fileDeleted = false;
  try {
    await unlink(CREDS_FILE);
    fileDeleted = true;
  } catch (err) {
    if (err !== null && typeof err === "object" && "code" in err && err.code === "ENOENT") {
      fileDeleted = true;
    } else {
      throw err;
    }
  }

  const env_active =
    Boolean(process.env["HW_ACCESS_KEY"]) &&
    Boolean(process.env["HW_SECRET_KEY"]) &&
    Boolean(process.env["HW_REGION_NAME"]);

  return { scope: SCOPE, keychain: keychainDeleted, file: fileDeleted, env_active };
}

/**
 * Read + parse the persisted payload ONCE, cache the result.
 *
 * Tries keychain first, then the machine-fingerprint fallback file. Both
 * store the same JSON shape ({ ak, sk, region, account_id?, account_name? }).
 * On total failure (no keychain, no file, unreadable) throws "not
 * authenticated" — callers (resolveTerraformEnv, signedHttp) surface that.
 *
 * The cache makes repeated calls in one tool invocation free: a single
 * runTerraform call used to hit the keychain 2x (loadCredentials +
 * loadAccount); now it hits 0-1x after the first.
 */
async function loadPersistedPayload(): Promise<PersistedPayload> {
  if (persistedCache) return persistedCache;

  const keychainPayload = await tryKeychainGet(SERVICE, ACCOUNT);
  let raw: string | null = keychainPayload;
  if (!raw) {
    const encrypted = await readFile(CREDS_FILE);
    raw = await fingerprintDecrypt(encrypted);
  }
  const parsed = JSON.parse(raw) as {
    ak: string;
    sk: string;
    region: string;
    account_id?: string;
    account_name?: string;
  };
  const credentials: Credentials = { ak: parsed.ak, sk: parsed.sk, region: parsed.region };
  const account: StoredAccount | null =
    parsed.account_id && parsed.account_name
      ? { account_id: parsed.account_id, account_name: parsed.account_name }
      : null;
  persistedCache = { credentials, account };
  return persistedCache;
}

/**
 * Load credentials (§5.4 getCredentials flow):
 *   1. In-memory session (STS)?
 *   2. Env vars (HW_ACCESS_KEY/HW_SECRET_KEY/HW_REGION_NAME)?
 *   3. Keychain (cached)?
 *   4. Machine-fingerprint file (cached)?
 *   5. → "not authenticated"
 *
 * Env vars take priority over the persisted store so that a client which
 * chooses to carry credentials in its own server config never touches the
 * shared layers at all. Clients that set no env vars fall back to this
 * process's scoped keychain entry and file (see `./scope.ts`), which is what
 * keeps them apart from one another.
 */
export async function loadCredentials(): Promise<Credentials> {
  if (sessionCredentials) return sessionCredentials;
  // Env vars — per-process, set by the MCP client config. Takes priority
  // over the persisted store to prevent cross-client credential leakage.
  const envAk = process.env["HW_ACCESS_KEY"];
  const envSk = process.env["HW_SECRET_KEY"];
  const envRegion = process.env["HW_REGION_NAME"];
  if (envAk && envSk && envRegion) {
    const envToken = process.env["HW_SECURITY_TOKEN"];
    return envToken
      ? { ak: envAk, sk: envSk, region: envRegion, security_token: envToken }
      : { ak: envAk, sk: envSk, region: envRegion };
  }
  try {
    return (await loadPersistedPayload()).credentials;
  } catch {
    throw new Error("not authenticated — call auth first");
  }
}

/**
 * Load the account identity stored alongside the credentials.
 *
 * Priority:
 *   1. In-memory session (STS with resolved account, or env-vars mode after
 *      IAM resolution).
 *   2. HW_ACCOUNT_ID env var (set by MCP client config alongside AK/SK env
 *      vars — lets multi-client setups avoid the persisted layers entirely).
 *   3. Keychain/file payload for this process's scope — the fallback when
 *      env vars aren't set.
 *
 * Returns null when none are available. Callers like resolveDomainId (RMS)
 * surface a clear error telling the user to re-run auth or set HW_ACCOUNT_ID.
 */
export async function loadAccount(): Promise<StoredAccount | null> {
  if (sessionCredentials?.account) return sessionCredentials.account;
  if (sessionCredentials) return null; // STS without account resolved
  // Env-var account_id — per-process, avoids the persisted layers.
  const envAccountId = process.env["HW_ACCOUNT_ID"];
  if (envAccountId) {
    return { account_id: envAccountId, account_name: process.env["HW_ACCOUNT_NAME"] ?? envAccountId };
  }
  try {
    return (await loadPersistedPayload()).account;
  } catch {
    return null;
  }
}
