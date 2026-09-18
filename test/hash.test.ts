import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { computeTfHash } from "../src/utils/hash.js";

describe("computeTfHash", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "hash-test-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("returns a sha256: prefixed hash", async () => {
    await writeFile(join(dir, "main.tf"), `resource "x" "y" {}\n`);
    const hash = await computeTfHash(dir);
    expect(hash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("is deterministic — same content produces same hash", async () => {
    await writeFile(join(dir, "main.tf"), `resource "x" "y" {}\n`);
    await writeFile(join(dir, "vars.tf"), `variable "z" {}\n`);
    const h1 = await computeTfHash(dir);
    const h2 = await computeTfHash(dir);
    expect(h1).toBe(h2);
  });

  it("changes when root .tf content changes", async () => {
    await writeFile(join(dir, "main.tf"), `resource "x" "y" {}\n`);
    const h1 = await computeTfHash(dir);
    await writeFile(join(dir, "main.tf"), `resource "x" "z" {}\n`);
    const h2 = await computeTfHash(dir);
    expect(h1).not.toBe(h2);
  });

  it("includes .tf in modules/ subdirectories", async () => {
    await mkdir(join(dir, "modules", "ecs"), { recursive: true });
    await writeFile(join(dir, "main.tf"), `resource "x" "y" {}\n`);
    await writeFile(join(dir, "modules", "ecs", "main.tf"), `resource "a" "b" {}\n`);
    const hashWithModule = await computeTfHash(dir);

    // Remove module file — hash should differ
    await rm(join(dir, "modules"), { recursive: true });
    const hashWithoutModule = await computeTfHash(dir);
    expect(hashWithModule).not.toBe(hashWithoutModule);
  });

  it("changes when modules/ .tf content changes", async () => {
    await mkdir(join(dir, "modules", "ecs"), { recursive: true });
    await writeFile(join(dir, "main.tf"), `resource "x" "y" {}\n`);
    await writeFile(join(dir, "modules", "ecs", "main.tf"), `resource "a" "b" {}\n`);
    const h1 = await computeTfHash(dir);
    await writeFile(join(dir, "modules", "ecs", "main.tf"), `resource "a" "c" {}\n`);
    const h2 = await computeTfHash(dir);
    expect(h1).not.toBe(h2);
  });

  it("excludes .terraform/ directory", async () => {
    await mkdir(join(dir, ".terraform"), { recursive: true });
    await writeFile(join(dir, "main.tf"), `resource "x" "y" {}\n`);
    await writeFile(join(dir, ".terraform", "provider.tf"), `resource "p" "q" {}\n`);
    const hash = await computeTfHash(dir);

    // Remove .terraform — hash should be the same (it was excluded)
    await rm(join(dir, ".terraform"), { recursive: true });
    const hashAfterRemove = await computeTfHash(dir);
    expect(hash).toBe(hashAfterRemove);
  });

  it("is order-independent — file order doesn't affect hash", async () => {
    await writeFile(join(dir, "a.tf"), `resource "a" "x" {}\n`);
    await writeFile(join(dir, "b.tf"), `resource "b" "y" {}\n`);
    const hash1 = await computeTfHash(dir);

    // Recreate in different order (content same)
    await rm(join(dir, "a.tf"));
    await rm(join(dir, "b.tf"));
    await writeFile(join(dir, "b.tf"), `resource "b" "y" {}\n`);
    await writeFile(join(dir, "a.tf"), `resource "a" "x" {}\n`);
    const hash2 = await computeTfHash(dir);
    expect(hash1).toBe(hash2);
  });
});
