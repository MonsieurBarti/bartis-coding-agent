import { beforeAll, describe, expect, it } from "bun:test";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseProfile } from "../../profile";
import { buildPrompt } from "../runner";

const PROFILE_YAML = `
project:
  language: typescript
  packageManager: bun
commands:
  test: bun test
rules:
  - Use strict TypeScript
  - No any types
`;

const profile = parseProfile(PROFILE_YAML);

describe("buildPrompt", () => {
  const tmpDir = join(tmpdir(), `bca-runner-prompt-test-${Date.now()}`);

  beforeAll(async () => {
    await mkdir(tmpDir, { recursive: true });
  });

  it("includes project language and package manager", async () => {
    const prompt = await buildPrompt(profile, "Fix the bug");
    expect(prompt).toContain("typescript");
    expect(prompt).toContain("bun");
  });

  it("includes rules from profile", async () => {
    const prompt = await buildPrompt(profile, "Fix the bug");
    expect(prompt).toContain("Use strict TypeScript");
    expect(prompt).toContain("No any types");
  });

  it("includes the task description", async () => {
    const prompt = await buildPrompt(profile, "Implement user auth");
    expect(prompt).toContain("Task:\nImplement user auth");
  });

  it("includes blueprint content when file exists", async () => {
    const bpPath = join(tmpDir, "blueprint.yaml");
    await writeFile(bpPath, "steps:\n  - lint\n  - test\n");

    try {
      const prompt = await buildPrompt(profile, "Run pipeline", bpPath);
      expect(prompt).toContain("Blueprint:");
      expect(prompt).toContain("- lint");
      expect(prompt).toContain("- test");
    } finally {
      await unlink(bpPath).catch(() => {});
    }
  });

  it("gracefully handles missing blueprint file", async () => {
    const prompt = await buildPrompt(profile, "Do work", "/nonexistent/blueprint.yaml");
    expect(prompt).toContain("Blueprint file not found");
    expect(prompt).toContain("Do work");
  });

  it("omits rules section when profile has no rules", async () => {
    const minProfile = parseProfile(`
project:
  language: go
`);
    const prompt = await buildPrompt(minProfile, "Build it");
    expect(prompt).not.toContain("Rules:");
    expect(prompt).toContain("go");
    expect(prompt).toContain("Build it");
  });
});

describe("module exports", () => {
  it("exports runPiAgent and types from index", async () => {
    const mod = await import("../index");
    expect(typeof mod.runPiAgent).toBe("function");
  });
});
