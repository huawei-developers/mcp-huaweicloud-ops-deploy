/**
 * Enforcement for read-only mode — the two gates.
 *
 * Read-only mode is enforced at two levels, because the server reaches
 * HuaweiCloud through two paths that do not share an entry point.
 *
 * ## Gate 1 — the signed-HTTP funnel
 *
 * Every signed request to a HuaweiCloud endpoint goes through `signedHttp`
 * (`openapi_request`, `existing_resources`, `balance_summary`, `apiexplorer`,
 * and IAM verification). Checking there covers every cloud call the agent can
 * compose itself, including the arbitrary method/URL that `openapi_request`
 * accepts, without each tool having to remember to ask.
 *
 * The check applies to every call, including the two in `auth/iam.ts` that
 * pass credentials explicitly while verifying not-yet-stored ones. Those are
 * GET requests, which the gate admits without consulting the registry, so
 * gating them costs nothing — and keying an exemption on whether a caller
 * happened to pass a parameter would leave a back door that opens for any
 * future caller of any method.
 *
 * ## Gate 2 — the tool registry
 *
 * The terraform tools shell out to the `terraform` binary and never touch
 * `signedHttp`, so gate 1 cannot see them. Two of them change cloud state:
 *
 *   - `terraform_apply` creates and modifies resources.
 *   - `terraform_destroy` deletes them.
 *
 * Everything else in that family only reads or writes local files —
 * `plan`, `init`, `refresh`, `import`, `state`, `install`, `provider_schema`,
 * `terraform_examples_export` — and stays available, so a read-only session
 * can still show a user what a change *would* do. Refusing `plan` would make
 * read-only mode useless for its main purpose: reviewing before approving.
 *
 * ## What this does not cover
 *
 * These gates protect cloud resources. They are not a sandbox: a terraform run
 * writes files, downloads providers, and spawns processes, and none of that is
 * gated. `terraform_plan` can still write a state file, and `terraform_import`
 * can still modify local state. That is by design — the promise is "will not
 * change your cloud account", and it is stated that way to users rather than
 * as a blanket "read-only".
 *
 * @module permission/gate
 */

import { writesAllowed, getMode } from "./mode.js";
import { isReadOnlyPermitted } from "./registry.js";

/**
 * Tools that change cloud state without going through `signedHttp`.
 *
 * Anything reached by `signedHttp` is covered by gate 1 and must NOT be listed
 * here — listing it would refuse reads that gate 1 already admits. A new tool
 * that mutates cloud state by some other route (a new binary, a direct fetch)
 * must be added.
 */
export const CLOUD_MUTATING_TOOLS: ReadonlySet<string> = new Set([
  "terraform_apply",
  "terraform_destroy",
]);

/** Prefix for every diagnostic this module writes. */
const LOG_PREFIX = "permission:";

/**
 * A refusal from the read-only gate.
 *
 * Its own type so callers can tell a policy decision from a transport failure:
 * tool code that wraps errors would otherwise report a refusal as
 * "request failed", which reads like a bug rather than a rule. `openapi.ts`
 * checks for this and returns the message verbatim.
 */
export class PermissionRefusalError extends Error {
  override readonly name = "PermissionRefusalError";
}

/**
 * Write a denial diagnostic to stderr.
 *
 * stderr, never a tool result: the model reads tool results, and the mode is
 * out of band. What the operator needs is the URL that was refused and the
 * reason — that is how a registry gap gets noticed and fixed.
 *
 * @param detail - what was denied and why.
 */
function logDenial(detail: string): void {
  process.stderr.write(`${LOG_PREFIX} ${detail}\n`);
}

/**
 * Check a tool call against read-only mode.
 *
 * @param toolName - the tool about to run.
 * @returns a message to return as a failed tool result, or `undefined` to proceed.
 */
export function denyTool(toolName: string): string | undefined {
  if (writesAllowed()) return undefined;
  if (!CLOUD_MUTATING_TOOLS.has(toolName)) return undefined;

  logDenial(`refused tool ${toolName} (mode=${getMode()})`);
  return (
    `Refused: ${toolName} changes HuaweiCloud resources, and this session is in ` +
    `read-only mode.\n\n` +
    `Read-only mode is controlled outside this conversation — a person switches it ` +
    `in the client UI, and no tool or argument can change it. To run ${toolName}, ` +
    `ask the user to switch the session to read-write mode.\n\n` +
    `Operations that only inspect state remain available: terraform_plan, ` +
    `terraform_state, terraform_refresh, apiexplorer, existing_resources, ` +
    `balance_summary, and read-only openapi_request calls.`
  );
}

/**
 * Check a signed HTTP request against read-only mode.
 *
 * @param method - HTTP method.
 * @param url - the full request URL.
 * @returns a message describing the refusal, or `undefined` to proceed.
 */
export function denyHttp(method: string, url: URL): string | undefined {
  if (writesAllowed()) return undefined;

  const decision = isReadOnlyPermitted(method, url);
  if (decision.allowed) return undefined;

  logDenial(
    `refused ${method.toUpperCase()} ${url.hostname}${url.pathname} ` +
      `(mode=${getMode()}, reason=${decision.reason})`,
  );

  switch (decision.reason) {
    case "registry-unavailable":
      return (
        `Refused: this session is in read-only mode and the permission registry ` +
        `could not be loaded, so the request cannot be cleared. GET and HEAD ` +
        `requests still work.\n\n` +
        `Run \`npm run build-permission-registry\` before building the server.`
      );
    case "registry-miss":
    default:
      return (
        `Refused: ${method.toUpperCase()} ${url.hostname}${url.pathname} is not a ` +
        `known read-only operation, and this session is in read-only mode.\n\n` +
        `Read-only mode permits GET and HEAD, plus operations the API catalog ` +
        `marks as queries. It is controlled outside this conversation — a person ` +
        `switches it in the client UI, and no tool or argument can change it. ` +
        `If this operation only reads data, ask the user to switch the session to ` +
        `read-write mode; if it modifies or deletes resources, it must stay refused.`
      );
  }
}