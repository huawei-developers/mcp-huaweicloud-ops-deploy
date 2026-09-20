/**
 * In-memory task lifecycle manager (§8.4).
 *
 * Tasks represent long-running terraform operations (apply/destroy/refresh).
 * State is purely in-memory: a server restart loses all tasks — the client
 * gets "task not found" on tasks/get and re-invokes. Terraform idempotency
 * is the safety net.
 *
 * No persistence, no .tasks/ directory, no global registry across
 * deployments. Each task records which deployment it belongs to so
 * tasks/get can correlate.
 */

import { randomUUID } from "node:crypto";

export type TaskStatus = "working" | "completed" | "failed" | "cancelled";

export interface Task {
  taskId: string;
  status: TaskStatus;
  statusMessage: string;
  createdAt: string;
  lastUpdatedAt: string;
  ttlMs: number | null;
  pollIntervalMs: number;
  deployment: string;
  /** Operation type: "apply" | "destroy" | "refresh" */
  operation: string;
  /** Populated on completion. */
  result?: Record<string, unknown>;
  /** Populated on failure. */
  error?: { code: number; message: string };
}

const POLL_INTERVAL_MS = 5000;

/** Map taskId → Task. Lost on process exit (by design, §8.4). */
const tasks = new Map<string, Task>();

/** Create a new task in "working" state. */
export function createTask(deployment: string, operation: string, statusMessage: string): Task {
  const now = new Date().toISOString();
  const task: Task = {
    taskId: randomUUID(),
    status: "working",
    statusMessage,
    createdAt: now,
    lastUpdatedAt: now,
    ttlMs: null,
    pollIntervalMs: POLL_INTERVAL_MS,
    deployment,
    operation,
  };
  tasks.set(task.taskId, task);
  return task;
}

/** Look up a task by id. */
export function getTask(taskId: string): Task | undefined {
  return tasks.get(taskId);
}

/** Update a task's status/message. */
export function updateTask(taskId: string, patch: Partial<Pick<Task, "status" | "statusMessage" | "result" | "error">>): void {
  const task = tasks.get(taskId);
  if (!task) return;
  if (patch.status !== undefined) task.status = patch.status;
  if (patch.statusMessage !== undefined) task.statusMessage = patch.statusMessage;
  if (patch.result !== undefined) task.result = patch.result;
  if (patch.error !== undefined) task.error = patch.error;
  task.lastUpdatedAt = new Date().toISOString();
}

/** Mark a task cancelled (if it exists). */
export function cancelTask(taskId: string): boolean {
  const task = tasks.get(taskId);
  if (!task) return false;
  if (task.status === "completed" || task.status === "failed") return false;
  task.status = "cancelled";
  task.lastUpdatedAt = new Date().toISOString();
  return true;
}
