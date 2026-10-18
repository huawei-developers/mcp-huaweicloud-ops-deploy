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
 * API: `new AsyncEntry(service, username, options?)` → `.getPassword()` /
 * `.setPassword()`.
 *
 * ## Linux: pinned to Secret Service, no kernel-keyring fallback
 *
 * The binding's default on Linux is to try Secret Service and then *silently
 * fall back* to the kernel keyutils keyring whenever Secret Service is
 * unavailable (no D-Bus session, no keyring daemon, a container). That
 * fallback is wrong here: keyutils keeps credentials in kernel memory and
 * drops them on reboot, so a write that reports success would silently stop
 * authenticating after a restart — the worst failure shape, since it looks
 * like "storage worked" until much later.
 *
 * So entries are pinned with `{ linux: { store: 'secret-service' } }`. When
 * Secret Service is unavailable the constructor throws instead of falling
 * back; this module's try/catch turns that into `null`/`false`, and the
 * caller (store.ts) routes to the machine-fingerprint file — a store that
 * genuinely persists. The pin is Linux-only (the option is ignored
 * elsewhere), so it is passed on Linux only.
 */

const KEYRING_MODULE = "@napi-rs/keyring";

interface KeyringEntry {
  getPassword(signal?: AbortSignal | null): Promise<string | undefined>;
  setPassword(password: string, signal?: AbortSignal | null): Promise<void>;
  deleteCredential(signal?: AbortSignal | null): Promise<boolean>;
}

/** Linux credential store the binding can be pinned to (see the module doc). */
interface LinuxEntryOptions {
  store?: "secret-service" | "keyutils";
}

interface EntryOptions {
  linux?: LinuxEntryOptions;
}

interface KeyringModule {
  AsyncEntry: new (service: string, username: string, options?: EntryOptions | null) => KeyringEntry;
}

/**
 * Entry options: pin to Secret Service on Linux, nothing elsewhere.
 *
 * See the module doc for why the keyutils fallback must be refused. On other
 * platforms the option bag is meaningless (and ignored by the binding), so it
 * is omitted entirely rather than passed as a no-op.
 */
const ENTRY_OPTIONS: EntryOptions | undefined =
  process.platform === "linux" ? { linux: { store: "secret-service" } } : undefined;

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
    const entry = new mod.AsyncEntry(service, account, ENTRY_OPTIONS);
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
    const entry = new mod.AsyncEntry(service, account, ENTRY_OPTIONS);
    await entry.setPassword(password);
    return true;
  } catch {
    return false;
  }
}

/**
 * Try to delete from keyring; return false if unavailable.
 *
 * `false` means the keyring could not be reached — the caller must still
 * attempt the fallback file. A present-but-missing entry deletes cleanly
 * (`deleteCredential` resolves `true` per the binding's contract), so a
 * second reset on an already-cleared scope is idempotent.
 */
export async function tryKeychainDelete(service: string, account: string): Promise<boolean> {
  const mod = await loadKeyring();
  if (!mod) return false;
  try {
    const entry = new mod.AsyncEntry(service, account, ENTRY_OPTIONS);
    await entry.deleteCredential();
    return true;
  } catch {
    return false;
  }
}
