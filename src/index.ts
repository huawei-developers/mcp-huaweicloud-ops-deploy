#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// huaweicloud-ops-deploy — MCP server entry point.
//
// Spawned by MCP clients (Claude Code, Cursor, ...) as a stdio child
// process. Reads JSON-RPC from stdin, writes to stdout. All logging
// MUST go to stderr — stdout is the protocol channel.

import { main } from "./server.js";

main().catch((err) => {
  process.stderr.write(`Fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});

// Guard against unhandled rejections (e.g. background task promises) crashing
// the server. Log to stderr; don't exit — the MCP server must stay alive.
process.on("unhandledRejection", (reason) => {
  process.stderr.write(`UnhandledRejection: ${reason instanceof Error ? reason.stack ?? reason.message : String(reason)}\n`);
});
