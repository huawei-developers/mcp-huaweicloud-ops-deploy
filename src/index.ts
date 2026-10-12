#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// huaweicloud-ops-deploy — MCP server entry point.
//
// Default: stdio. Spawned by MCP clients (Claude Code, Cursor, ...) as a
// child process; reads JSON-RPC from stdin, writes to stdout. All logging
// MUST go to stderr — stdout is the protocol channel.
//
// HTTP/remote mode: `--transport http [--port 9527] [--host 127.0.0.1]`.
// Serves the Streamable HTTP transport; see `serveHttp` in server.ts for the
// binding and security model. HTTP mode is for a single operator behind a
// reverse proxy — credentials and permission mode stay process-wide.

import { main, serveHttp } from "./server.js";

interface CliArgs {
  transport: "stdio" | "http";
  port: number;
  host: string;
}

/**
 * Parse the CLI arguments. Unknown flags are ignored (not a hard error) so a
 * future flag can land without breaking older callers; an invalid value for a
 * known flag does fail, because misparsing `--port` would silently bind the
 * wrong port.
 */
function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    transport: "stdio",
    port: 9527,
    host: "127.0.0.1",
  };
  // Track which flags were given explicitly, so a flag that is meaningless in
  // the chosen transport can be rejected rather than silently dropped — a
  // user who writes `--transport stdio --port 8080` almost certainly meant
  // HTTP, and silently ignoring the port would leave them debugging stdio.
  const explicit = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--transport": {
        explicit.add("--transport");
        const value = argv[++i];
        if (value !== "stdio" && value !== "http") {
          throw new Error(`--transport must be "stdio" or "http", got "${value ?? ""}"`);
        }
        args.transport = value;
        break;
      }
      case "--port": {
        explicit.add("--port");
        const value = argv[++i];
        const port = Number(value);
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
          throw new Error(`--port must be an integer 1-65535, got "${value ?? ""}"`);
        }
        args.port = port;
        break;
      }
      case "--host": {
        explicit.add("--host");
        const value = argv[++i];
        if (!value) throw new Error("--host requires a value");
        args.host = value;
        break;
      }
      // Unknown flags fall through; a leading positional (e.g. a subcommand
      // name) is also ignored. The server has no subcommands today.
    }
  }
  // --port/--host only apply to HTTP. In stdio mode they are meaningless —
  // reject them so a mistyped --transport doesn't look like it worked.
  if (args.transport === "stdio") {
    if (explicit.has("--port")) throw new Error("--port has no effect with --transport stdio (did you mean --transport http?)");
    if (explicit.has("--host")) throw new Error("--host has no effect with --transport stdio (did you mean --transport http?)");
  }
  return args;
}

// Parse inside a Promise so a bad argument combination (e.g. `--transport
// stdio --port 8080`) is caught by the same .catch() as a runtime failure —
// otherwise the throw at module top level would surface as a raw stack trace
// with exit code 0 instead of a clean Fatal: line and exit 1.
const startup = Promise.resolve().then(() => {
  const args = parseArgs(process.argv.slice(2));
  return args.transport === "http" ? serveHttp(args.port, args.host) : main();
});

startup.catch((err) => {
  process.stderr.write(`Fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});

// Guard against unhandled rejections (e.g. background task promises) crashing
// the server. Log to stderr; don't exit — the MCP server must stay alive.
process.on("unhandledRejection", (reason) => {
  process.stderr.write(`UnhandledRejection: ${reason instanceof Error ? reason.stack ?? reason.message : String(reason)}\n`);
});
