/**
 * Approval mode — the out-of-band read-only / read-write switch.
 *
 * ## What this gates
 *
 * Read-only mode protects **HuaweiCloud resources**: it stops the agent from
 * creating, modifying, or deleting anything in the account. It is not a
 * sandbox. Operations with no cloud effect — a terraform binary run, a plan
 * file written to disk, a local command — are outside what this switch can
 * see, and are not claimed to be covered.
 *
 * ## Why the mode lives here and not in the conversation
 *
 * The switch is out-of-band: a human flips it in the client UI, which reaches
 * this process as an MCP request (see `methods.ts`), and this module's memory
 * changes.
 *
 * The mode is not an exposed surface: it appears in no tool description, no
 * tool result, and no `tools/list` entry, and no tool sets it. An agent cannot
 * read it on demand, and cannot argue its way into write access.
 *
 * A denial, however, does reveal the current state — `denyTool` and `denyHttp`
 * name read-only mode in the message they return. That is deliberate, and it
 * is not closable by wording: were the session in read-write the request would
 * not be refused at all, so the mere fact of refusal carries the same one bit
 * whatever the text says. A refusal that explained nothing would only make the
 * model retry and leave the user without a remedy. The state is one-way
 * observable at the moment it blocks you, and one-way unchangeable — which is
 * the property that matters.
 *
 * The mode is deliberately not persisted. A restart returns to the default,
 * so a session that needs write access must be granted it again — the safe
 * direction to fail.
 *
 * @module permission/mode
 */

/** Whether mutations are permitted. */
export type PermissionMode = "read_only" | "read_write";

/**
 * Environment variable holding the startup default.
 *
 * Read once at module load and never re-read, so the mode cannot be changed
 * by anything the agent can influence at runtime. It is intentionally absent
 * from the server's instructions and from every tool description: it is an
 * operator knob, not something the model is meant to reason about.
 */
const DEFAULT_MODE_ENV = "HW_DEFAULT_PERMISSION";

/** The mode when nothing overrides it. */
const FALLBACK_MODE: PermissionMode = "read_only";

/**
 * Parse a mode string.
 *
 * Accepts the wire spellings plus a few the operator is likely to type in an
 * environment variable. Anything unrecognised yields `undefined` rather than
 * throwing, so a typo degrades to the default instead of failing startup.
 *
 * @param value - candidate string.
 * @returns the mode, or `undefined` when unrecognised.
 */
export function parseMode(value: string | undefined): PermissionMode | undefined {
  if (value === undefined) return undefined;
  switch (value.trim().toLowerCase()) {
    case "read_only":
    case "read-only":
    case "readonly":
    case "ro":
      return "read_only";
    case "read_write":
    case "read-write":
    case "readwrite":
    case "rw":
      return "read_write";
    default:
      return undefined;
  }
}

/** Current mode. Module-level state — one server instance per connection. */
let current: PermissionMode = parseMode(process.env[DEFAULT_MODE_ENV]) ?? FALLBACK_MODE;

/** The mode in effect. */
export function getMode(): PermissionMode {
  return current;
}

/**
 * Set the mode.
 *
 * @param mode - the mode to apply.
 * @returns the previous mode, for a change log.
 */
export function setMode(mode: PermissionMode): PermissionMode {
  const previous = current;
  current = mode;
  return previous;
}

/** Whether mutations are currently permitted. */
export function writesAllowed(): boolean {
  return current === "read_write";
}

/**
 * Reset to the startup default.
 *
 * Used by tests, which must not leak a mode change into the next case.
 */
export function resetMode(): void {
  current = parseMode(process.env[DEFAULT_MODE_ENV]) ?? FALLBACK_MODE;
}

/** Startup default, for logging and for `permission/get_mode`. */
export function defaultMode(): PermissionMode {
  return parseMode(process.env[DEFAULT_MODE_ENV]) ?? FALLBACK_MODE;
}