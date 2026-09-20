/**
 * networking_gate.ts — existence check for networking.json (§6.3 门 1).
 *
 * Weak gate: only proves the networking design was persisted. Cannot
 * verify .tf matches the design (HCL semantics, needs AI).
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

export async function networkingJsonExists(dir: string): Promise<boolean> {
  try {
    await readFile(join(dir, "networking.json"), "utf8");
    return true;
  } catch {
    return false;
  }
}

export async function assertNetworking(dir: string): Promise<void> {
  if (!(await networkingJsonExists(dir))) {
    throw new Error("networking.json not found — call update_networking first");
  }
}
