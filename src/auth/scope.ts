/**
 * Credential scope — the per-client namespace for stored credentials.
 *
 * ## The problem this solves
 *
 * `store.ts` keeps every client's credentials in one place: the OS keychain
 * entry `("huaweicloud-ops-deploy", "default")`, falling back to the single
 * file `~/.huaweicloud-ops-deploy/credentials.enc`. On a machine where more
 * than one MCP client runs this server, those clients overwrite each other:
 * the last one to authenticate wins, and clearing credentials from one client
 * leaves the other's copy in place — so a "cleared" client keeps working off
 * whoever wrote last.
 *
 * The server already documents the intended isolation for one layer
 * (`loadCredentials`): each client sets its own `HW_ACCESS_KEY`/`HW_SECRET_KEY`
 * in its server config, and the environment wins over the shared store. That
 * covers clients *willing* to put credentials in an environment — but the
 * keychain and file layers had no way to separate clients at all, because
 * their names were hardcoded.
 *
 * A scope gives every client its own keychain account and its own file, so
 * isolation no longer depends on a client opting into the environment
 * channel.
 *
 * ## Why an invalid scope is fatal
 *
 * `parseMode` (permission/mode.ts) deliberately degrades an unrecognised value
 * to the default, because its input is a closed enum: a typo can only ever
 * mean "the operator meant one of these two". A scope is a free-form name, so
 * the same leniency would be actively harmful — a mistyped scope would fall
 * back to `default` and **silently share the keychain with every other
 * unset client**, which is the exact confusion this module exists to remove.
 * Failing loudly is the only safe direction.
 *
 * The value also reaches a filesystem path, so it is validated as a strict
 * identifier rather than merely "not obviously a path": no separators, no
 * dots, no leading dash or underscore. Assuming a value is benign because a
 * caller is trusted is how path traversal gets in.
 *
 * ## Stability of the names
 *
 * The default scope is the string `"default"`, and the default scope's file
 * keeps its original name `credentials.enc` (only non-default scopes get a
 * suffixed name). Both choices are deliberate: an existing installation that
 * has never set this variable must keep reading the credentials it already
 * stored, with no migration step.
 *
 * @module auth/scope
 */

/**
 * Environment variable naming the credential scope.
 *
 * Namespaced rather than a short `HW_*` name: this is a per-client knob that
 * several unrelated MCP servers could plausibly want, and a generic name
 * would collide in a shared client config.
 */
export const SCOPE_ENV = "HUAWEICLOUD_OPS_DEPLOY_CREDENTIAL_SCOPE";

/** Scope used when the environment names none. */
export const DEFAULT_SCOPE = "default";

/** Longest accepted scope. Bounded so a scope cannot overflow a filename. */
const SCOPE_MAX_LENGTH = 64;

/**
 * Accepted scope shape: a lowercase identifier.
 *
 * First character must be alphanumeric so a scope can never begin a path
 * component that a shell or filesystem would read specially (`-`, `.`).
 */
const SCOPE_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

/**
 * Normalize and validate a scope.
 *
 * Case and surrounding whitespace are folded, matching `parseMode`, so `DSH`
 * and `" dsh "` both mean `dsh`. Folding is not an escape hatch for
 * distinguishing scopes by case — they collide by design, and the README says
 * so.
 *
 * @param value - raw value from the environment.
 * @returns the normalized scope; `DEFAULT_SCOPE` when unset or blank.
 * @throws when the value is not a valid scope — never falls back silently,
 *   because a silent fallback shares the keychain with every unset client.
 */
export function parseScope(value: string | undefined): string {
  if (value === undefined) return DEFAULT_SCOPE;
  const normalized = value.trim().toLowerCase();
  if (normalized.length === 0) return DEFAULT_SCOPE;
  if (normalized.length > SCOPE_MAX_LENGTH || !SCOPE_PATTERN.test(normalized)) {
    throw new Error(
      `${SCOPE_ENV}=${JSON.stringify(value)} is not a valid credential scope: ` +
        `expected 1-${SCOPE_MAX_LENGTH} characters of [a-z0-9_-], starting with a letter or digit ` +
        `(for example "dsh" or "claude-code"). ` +
        `Unset it to use the shared "${DEFAULT_SCOPE}" scope.`,
    );
  }
  return normalized;
}

/**
 * Keychain account name for a scope.
 *
 * The account *is* the scope: the keychain service stays
 * `huaweicloud-ops-deploy` for every client, and this name carries the
 * separation. For `DEFAULT_SCOPE` the result is the literal string that was
 * hardcoded before scopes existed, which is what keeps existing keychain
 * entries readable.
 *
 * @param scope - a scope from {@link parseScope}.
 */
export function keychainAccount(scope: string): string {
  return scope;
}

/**
 * Fallback filename (inside the credentials directory) for a scope.
 *
 * `DEFAULT_SCOPE` maps to the original, unsuffixed name so that a file
 * written before scopes existed is still found. Other scopes are suffixed,
 * so the scopes' files sit side by side without colliding.
 *
 * @param scope - a scope from {@link parseScope}.
 */
export function credentialsFileName(scope: string): string {
  return scope === DEFAULT_SCOPE ? "credentials.enc" : `credentials.${scope}.enc`;
}
