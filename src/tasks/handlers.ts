/**
 * Task method handlers — registered on the low-level Server via
 * setRequestHandler's 3-arg custom-method overload (§8.2).
 *
 * The SDK 2.0.0 does NOT provide a task runtime: task wire types are
 * @deprecated "2025-11-25 wire vocabulary with no SDK runtime". But:
 *   - ServerCapabilitiesSchema has a `tasks` field (referencing the
 *     deprecated ServerTasksCapabilitySchema; registerCapabilities does
 *     not validate deprecation — only merges, mcp-D7GmuPnv.cjs:799-804).
 *   - Protocol.setRequestHandler(method: string, { params, result }, handler)
 *     supports arbitrary custom methods (SDK doc example: 'acme/search').
 *   - McpServer.server is a readonly public property exposing the
 *     low-level Server for "advanced operations like sending notifications".
 *
 * So we vendor the ext-tasks 2026-07-28 Stable schema (§8.2 字段名对齐)
 * and register tasks/get + tasks/cancel handlers ourselves. The
 * `tasks: { list: {} }` capability is NOT declared — ext-tasks 2026-07-28
 * removed tasks/list (spec: "Because there is no tasks/list").
 *
 * NOTE: registerCapabilities must be called BEFORE connect() — the guard
 * throws AlreadyConnected if the transport is attached. The caller
 * (createServer) invokes this before mcp.connect(transport).
 */

import type { Server } from "@modelcontextprotocol/server";
import { z } from "zod";

import { cancelTask, getTask, type Task } from "./manager.js";

// Vendored ext-tasks 2026-07-28 Stable schemas.
// These are the authority for task wire shapes — the SDK's built-in
// TaskSchema is 2025-11-25 deprecated and uses different field names
// (ttl/pollInterval vs ttlMs/pollIntervalMs). See §8.2 字段名对齐.
import {
  GetTaskRequestSchema,
  CancelTaskRequestSchema,
  GetTaskResultSchema,
  CancelTaskResultSchema,
  type GetTaskResult,
} from "../vendored/ext-tasks/schema.js";

/**
 * Register tasks/get and tasks/cancel on the low-level Server.
 *
 * Called from createServer() before mcp.connect(transport). The tasks
 * capability is declared in the McpServer constructor options
 * (server.ts), not here — registerCapabilities on the low-level Server
 * would also work but the high-level constructor is the canonical place.
 */
export function registerTaskHandlers(server: Server): void {
  // tasks/get — poll a task's status.
  // Params: { taskId: string }. Returns a DetailedTask (the full task
  // object with result/error populated per status).
  server.setRequestHandler(
    "tasks/get",
    {
      params: GetTaskRequestSchema,
      result: GetTaskResultSchema,
    },
    async (params) => {
      const task = getTask(params.taskId);
      if (!task) {
        throw new Error(`task not found: ${params.taskId}`);
      }
      return toWireTask(task);
    },
  );

  // tasks/cancel — mark a task cancelled. Idempotent per spec: cancelling an
  // already-terminal task (completed/failed) is a no-op that returns the
  // current state, not an error.
  server.setRequestHandler(
    "tasks/cancel",
    {
      params: CancelTaskRequestSchema,
      result: CancelTaskResultSchema,
    },
    async (params) => {
      const task = getTask(params.taskId);
      if (!task) throw new Error(`task not found: ${params.taskId}`);
      // cancelTask mutates status to "cancelled" if working; for terminal
      // states it's a no-op. We don't depend on the return value — the task
      // (now mutated or unchanged) is returned below either way.
      cancelTask(params.taskId);
      return toWireTask(task);
    },
  );
}

/**
 * Convert internal Task → wire GetTaskResult (ext-tasks 2026-07-28 shape).
 *
 * Field names: ttlMs / pollIntervalMs / createdAt / lastUpdatedAt (NOT the
 * 2025 deprecated ttl / pollInterval). See §8.2 字段名对齐.
 *
 * The result includes `resultType: "complete"` — ext-tasks 2026-07-28 spec
 * requires it on tasks/get + tasks/cancel results (clients discriminate by it).
 *
 * The DetailedTaskSchema is a discriminated union on `status` — each branch
 * requires a specific status literal, so we must return the matching literal
 * (not the broad TaskStatus type) per branch.
 */
function toWireTask(task: Task): GetTaskResult {
  const base = {
    resultType: "complete" as const,
    taskId: task.taskId,
    statusMessage: task.statusMessage,
    createdAt: task.createdAt,
    lastUpdatedAt: task.lastUpdatedAt,
    ttlMs: task.ttlMs,
    pollIntervalMs: task.pollIntervalMs,
  };
  switch (task.status) {
    case "completed":
      return { ...base, status: "completed", result: task.result ?? {} };
    case "failed":
      return {
        ...base,
        status: "failed",
        error: task.error ?? { code: -32000, message: "unknown failure" },
      };
    case "working":
      return { ...base, status: "working" };
    case "cancelled":
      return { ...base, status: "cancelled" };
  }
}
