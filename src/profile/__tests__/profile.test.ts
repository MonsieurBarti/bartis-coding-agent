import { describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_TOOLS,
  loadProfile,
  PipelineProfileSchema,
  ProfileLoadError,
  parseProfile,
} from "../index";

describe("parseProfile", () => {
  test("minimal config with only required fields", () => {
    const profile = parseProfile(`
project:
  language: python
`);
    expect(profile.project.language).toBe("python");
    expect(profile.project.packageManager).toBe("npm");
    expect(profile.tools).toEqual([...DEFAULT_TOOLS]);
    expect(profile.rules).toEqual([]);
    expect(profile.git.baseBranch).toBe("main");
    expect(profile.git.commitPrefix).toBe("");
    expect(profile.commands).toEqual({});
    expect(profile.pr).toEqual({});
  });

  test("full config preserves all values", () => {
    const profile = parseProfile(`
project:
  language: typescript
  packageManager: bun
commands:
  install: bun install
  lint: bun run lint
  test: bun test
  build: bun run build
  format: bun run format
  typecheck: bun run typecheck
tools:
  - read
  - bash
rules:
  - CLAUDE.md
  - .cursorrules
git:
  baseBranch: develop
  commitPrefix: "feat: "
pr:
  template: .github/PULL_REQUEST_TEMPLATE.md
`);
    expect(profile.project.language).toBe("typescript");
    expect(profile.project.packageManager).toBe("bun");
    expect(profile.commands.install).toBe("bun install");
    expect(profile.commands.lint).toBe("bun run lint");
    expect(profile.commands.test).toBe("bun test");
    expect(profile.commands.build).toBe("bun run build");
    expect(profile.commands.format).toBe("bun run format");
    expect(profile.commands.typecheck).toBe("bun run typecheck");
    expect(profile.tools).toEqual(["read", "bash"]);
    expect(profile.rules).toEqual(["CLAUDE.md", ".cursorrules"]);
    expect(profile.git.baseBranch).toBe("develop");
    expect(profile.git.commitPrefix).toBe("feat: ");
    expect(profile.pr.template).toBe(".github/PULL_REQUEST_TEMPLATE.md");
  });

  test("rejects invalid tool names", () => {
    expect(() =>
      parseProfile(`
project:
  language: go
tools:
  - nonexistent_tool
`),
    ).toThrow();
  });

  test("rejects missing project.language", () => {
    expect(() =>
      parseProfile(`
project:
  packageManager: bun
`),
    ).toThrow();
  });

  test("rejects completely empty config", () => {
    expect(() => parseProfile("")).toThrow();
  });

  test("partial commands are fine", () => {
    const profile = parseProfile(`
project:
  language: rust
commands:
  test: cargo test
`);
    expect(profile.commands.test).toBe("cargo test");
    expect(profile.commands.lint).toBeUndefined();
    expect(profile.commands.build).toBeUndefined();
  });
});

describe("loadProfile", () => {
  const tmpBase = join(tmpdir(), `bca-profile-test-${Date.now()}`);

  test("loads valid YAML from .pi/pipeline.yaml", async () => {
    const projectRoot = join(tmpBase, "valid");
    await mkdir(join(projectRoot, ".pi"), { recursive: true });
    await writeFile(
      join(projectRoot, ".pi/pipeline.yaml"),
      `
project:
  language: typescript
  packageManager: bun
commands:
  test: bun test
`,
    );

    const profile = await loadProfile(projectRoot);
    expect(profile.project.language).toBe("typescript");
    expect(profile.commands.test).toBe("bun test");
  });

  test("loads from custom path", async () => {
    const projectRoot = join(tmpBase, "custom");
    await mkdir(projectRoot, { recursive: true });
    await writeFile(
      join(projectRoot, "custom-config.yaml"),
      `
project:
  language: go
`,
    );

    const profile = await loadProfile(projectRoot, "custom-config.yaml");
    expect(profile.project.language).toBe("go");
  });

  test("throws ProfileLoadError for missing file", async () => {
    try {
      await loadProfile("/nonexistent/path");
      expect(true).toBe(false); // should not reach
    } catch (err) {
      expect(err).toBeInstanceOf(ProfileLoadError);
      expect((err as ProfileLoadError).message).toContain("Cannot read config");
    }
  });

  test("throws ProfileLoadError for invalid YAML", async () => {
    const projectRoot = join(tmpBase, "invalid-yaml");
    await mkdir(join(projectRoot, ".pi"), { recursive: true });
    await writeFile(join(projectRoot, ".pi/pipeline.yaml"), `{{{not valid yaml`);

    try {
      await loadProfile(projectRoot);
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(ProfileLoadError);
      expect((err as ProfileLoadError).message).toContain("Invalid YAML");
    }
  });

  test("throws ProfileLoadError for schema violations", async () => {
    const projectRoot = join(tmpBase, "bad-schema");
    await mkdir(join(projectRoot, ".pi"), { recursive: true });
    await writeFile(
      join(projectRoot, ".pi/pipeline.yaml"),
      `
project:
  packageManager: bun
`,
    );

    try {
      await loadProfile(projectRoot);
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(ProfileLoadError);
      expect((err as ProfileLoadError).message).toContain("Validation failed");
    }
  });

  // Cleanup
  test("cleanup tmp", async () => {
    await rm(tmpBase, { recursive: true, force: true });
  });
});

describe("PipelineProfileSchema", () => {
  test("safeParse returns success for valid input", () => {
    const result = PipelineProfileSchema.safeParse({
      project: { language: "python" },
    });
    expect(result.success).toBe(true);
  });

  test("safeParse returns error for invalid input", () => {
    const result = PipelineProfileSchema.safeParse({ project: {} });
    expect(result.success).toBe(false);
  });
});
