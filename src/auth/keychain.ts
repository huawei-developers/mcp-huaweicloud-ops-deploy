/**
 * OS keyring access via @napi-rs/keyring (keyring-rs Node binding).
 *
 * DESIGN.zh.md §5.2: keychain is the preferred credential store. This uses
 * @napi-rs/keyring's AsyncEntry (v2.1.0, actively maintained) instead of the
 * deprecated `keytar` (last published 2022). AsyncEntry is truly async —
 * the sync Entry blocks the Node event loop while the napi binding talks to
 * the OS keyring daemon (D-Bus on Linux, SecItem on macOS), which can stall
 * the entire MCP server when the daemon is slow.
 *
 * The binding ships prebuilt binaries for macOS/Windows/Linux (Secret
 * Service via D-Bus). When the keyring is unavailable (headless, no D-Bus,
 * container), the functions here return `null`/`false` and the caller falls
 * back to the machine-fingerprint file.
 *
 * The import is dynamic so the server can start even if the native binding
 * fails to load on an unsupported platform — the fallback path still works.
 *
 * API: `new AsyncEntry(service, username)` → `.getPassword()` / `.setPassword()`.
 */

const KEYRING_MODULE = "@napi-rs/keyring";

interface KeyringEntry {
  getPassword(signal?: AbortSignal | null): Promise<string | undefined>;
  setPassword(password: string, signal?: AbortSignal | null): Promise<void>;
}

interface KeyringModule {
  AsyncEntry: new (service: string, username: string) => KeyringEntry;
}

async function loadKeyring(): Promise<KeyringModule | null> {
  try {
    const mod = (await import(KEYRING_MODULE)) as KeyringModule;
    return mod;
  } catch {
    // Native binding missing or platform unsupported — caller falls back.
    return null;
  }
}

/** Try to read from keyring; return null if unavailable or not found. */
export async function tryKeychainGet(service: string, account: string): Promise<string | null> {
  const mod = await loadKeyring();
  if (!mod) return null;
  try {
    const entry = new mod.AsyncEntry(service, account);
    const password = await entry.getPassword();
    return password ?? null;
  } catch {
    return null;
  }
}

/** Try to write to keyring; return false if unavailable. */
export async function tryKeychainSet(service: string, account: string, password: string): Promise<boolean> {
  const mod = await loadKeyring();
  if (!mod) return false;
  try {
    const entry = new mod.AsyncEntry(service, account);
    await entry.setPassword(password);
    return true;
  } catch {
    return false;
  }
}
