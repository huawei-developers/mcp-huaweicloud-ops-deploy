/**
 * Single source of truth for the server version.
 *
 * Read from package.json (the npm package version). Both server.ts and
 * deployment/state.ts import from here — no circular deps (this module
 * imports only package.json, nothing in src/).
 */
import packageJson from "../package.json" with { type: "json" };

export const SERVER_VERSION = packageJson.version;
