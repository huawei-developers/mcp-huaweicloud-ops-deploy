/**
 * Vendored `io.modelcontextprotocol/tasks` 2026-07-28 Stable schema.
 *
 * Source: modelcontextprotocol/ext-tasks repo, schema/2026-07-28/.
 *
 * The SDK 2.0.0 ships 2025-11-25 deprecated task wire types with
 * different field names (ttl / pollInterval vs ttlMs / pollIntervalMs).
 * We vendor the 2026-07-28 Stable schema here as the authority for task
 * wire shapes — see DESIGN.zh.md §8.2 字段名对齐.
 *
 * These are the minimal types needed for tasks/get + tasks/cancel handler
 * registration and the CreateTaskResult returned by long-running tools.
 */

import { z } from "zod";

/** Base request params — matches MCP's BaseRequestParams shape. */
const BaseRequestParamsSchema = z.object({
  _meta: z.record(z.string(), z.unknown()).optional(),
});

/** tasks/get request: { taskId }. */
export const GetTaskRequestSchema = BaseRequestParamsSchema.extend({
  taskId: z.string(),
});

/** tasks/cancel request: { taskId }. */
export const CancelTaskRequestSchema = BaseRequestParamsSchema.extend({
  taskId: z.string(),
});

/**
 * Task status enum (ext-tasks 2026-07-28).
 * `input_required` is the elicitation-paused state — not used by our
 * terraform tasks (we don't elicit mid-apply).
 */
export const TaskStatusSchema = z.enum([
  "working",
  "input_required",
  "completed",
  "failed",
  "cancelled",
]);

/**
 * A pollable task. Field names are 2026-07-28 (ttlMs / pollIntervalMs),
 * NOT the 2025 deprecated (ttl / pollInterval).
 */
export const TaskSchema = z.object({
  taskId: z.string(),
  status: TaskStatusSchema,
  statusMessage: z.string().optional(),
  createdAt: z.string(),
  lastUpdatedAt: z.string(),
  ttlMs: z.union([z.number(), z.null()]),
  pollIntervalMs: z.number().optional(),
});

/** A completed task with its result. */
export const CompletedTaskSchema = TaskSchema.extend({
  status: z.literal("completed"),
  result: z.record(z.string(), z.unknown()),
});

/** A failed task with its error. */
export const FailedTaskSchema = TaskSchema.extend({
  status: z.literal("failed"),
  error: z.object({ code: z.number(), message: z.string() }),
});

/** A working task (no result/error yet). */
export const WorkingTaskSchema = TaskSchema.extend({
  status: z.literal("working"),
});

/** The union returned by tasks/get — a "detailed" task with status-specific fields. */
export const DetailedTaskSchema = z.discriminatedUnion("status", [
  WorkingTaskSchema,
  CompletedTaskSchema,
  FailedTaskSchema,
  TaskSchema.extend({ status: z.literal("input_required") }),
  TaskSchema.extend({ status: z.literal("cancelled") }),
]);

/**
 * CreateTaskResult — what a long-running tool returns from tools/call
 * to signal "I started a task, poll tasks/get for the result".
 *
 * Per §8.2: the high-level McpServer.registerTool callback type is
 * CallToolResult | InputRequiredResult — CreateTaskResult is NOT in the
 * union. We return it via `as unknown as CallToolResult`. The runtime
 * chain does not intercept (§8.2):
 *   - validateToolOutput skips when outputSchema is absent (we don't declare one)
 *   - 2025-era codec: appendTextFallbackForNonObject returns result as-is
 *     when structuredContent is undefined (src-STyD_Vvf.cjs:580-591)
 *   - 2026-era codec: tools/call ∈ EXTENDED_RESULT_TYPE_METHODS, open
 *     union passes through (src-STyD_Vvf.cjs:3758)
 */
export const CreateTaskResultSchema = z.object({
  resultType: z.literal("task"),
  taskId: z.string(),
  status: TaskStatusSchema,
  statusMessage: z.string().optional(),
  createdAt: z.string(),
  lastUpdatedAt: z.string(),
  ttlMs: z.union([z.number(), z.null()]),
  pollIntervalMs: z.number().optional(),
});

/**
 * Result schemas for tasks/get + tasks/cancel handlers.
 *
 * ext-tasks 2026-07-28 spec: the result of tasks/get is
 *   GetTaskResult = Result & DetailedTask & { resultType: "complete" }
 * The resultType discriminator is required — clients parse by it. The SDK's
 * own 2025-11-25 deprecated GetTaskResultSchema omits it (Result.merge(Task)),
 * but we vendor the 2026-07-28 spec and follow its shape.
 */
export const GetTaskResultSchema = DetailedTaskSchema.and(
  z.object({ resultType: z.literal("complete") }),
);

export const CancelTaskResultSchema = DetailedTaskSchema.and(
  z.object({ resultType: z.literal("complete") }),
);

// Type exports for handler signatures.
export type TaskStatus = z.infer<typeof TaskStatusSchema>;
export type DetailedTask = z.infer<typeof DetailedTaskSchema>;
export type CreateTaskResult = z.infer<typeof CreateTaskResultSchema>;
export type GetTaskResult = z.infer<typeof GetTaskResultSchema>;
export type CancelTaskResult = z.infer<typeof CancelTaskResultSchema>;
