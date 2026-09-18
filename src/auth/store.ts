/**
 * Credential storage — keychain first, machine-fingerprint file fallback.
 *
 * DESIGN.zh.md §5.2: OS keychain (macOS Keychain / Windows DPAPI / Linux
 * Secret Service) is preferred. When unavailable (headless Linux, Docker,
 * no keyring daemon), fall back to a machine-fingerprint-derived
 * AES-256-GCM encrypted file at ~/.huaweicloud-ops-deploy/credentials.enc.
 *
 * STS (security_token) credentials are NEVER persisted — they expire. They
 * live only in the in-memory session cache for the process lifetime.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";

import { tryKeychainGet, tryKeychainSet } from "./keychain.js";
import { fingerprintDecrypt, fingerprintEncrypt } from "./fingerprint.js";

const SERVICE = "huaweicloud-ops-deploy";
const ACCOUNT = "default";
const CREDS_DIR = join(homedir(), ".huaweicloud-ops-deploy");
const CREDS_FILE = join(CREDS_DIR, "credentials.enc");

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
 * Env vars take priority over keychain so that multiple MCP clients on the
 * same machine don't cross-contaminate credentials: each client sets its own
 * env vars in its server config, and loadCredentials picks those up without
 * touching the shared keychain. A client that sets no env vars falls back to
 * the keychain (shared, single-account).
 */
export async function loadCredentials(): Promise<Credentials> {
  if (sessionCredentials) return sessionCredentials;
  // Env vars — per-process, set by the MCP client config. Takes priority
  // over the shared keychain to prevent cross-client credential leakage.
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
 *      vars — lets multi-client setups avoid the shared keychain entirely).
 *   3. Keychain/file payload (shared across processes — the single-account
 *      fallback when env vars aren't set).
 *
 * Returns null when none are available. Callers like resolveDomainId (RMS)
 * surface a clear error telling the user to re-run auth or set HW_ACCOUNT_ID.
 */
export async function loadAccount(): Promise<StoredAccount | null> {
  if (sessionCredentials?.account) return sessionCredentials.account;
  if (sessionCredentials) return null; // STS without account resolved
  // Env-var account_id — per-process, avoids shared keychain.
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
