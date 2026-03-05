import { describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getProject,
  loadProjectRegistry,
  ProjectRegistryLoadError,
  ProjectRegistrySchema,
  parseProjectRegistry,
} from "../index";

const VALID_YAML = `
default: bca
projects:
  bca:
    repo: https://github.com/anthropics/bca.git
    branch: main
    profile: .pi/pipeline.yaml
    language: typescript
    description: Build-Code-Audit pipeline
  gastown:
    repo: https://github.com/anthropics/gastown.git
    language: go
    description: Multi-agent workspace manager
`;

describe("parseProjectRegistry", () => {
  test("parses full config with all fields", () => {
    const registry = parseProjectRegistry(VALID_YAML);
    expect(registry.default).toBe("bca");
    expect(Object.keys(registry.projects)).toEqual(["bca", "gastown"]);

    const bca = registry.projects.bca;
    expect(bca.repo).toBe("https://github.com/anthropics/bca.git");
    expect(bca.branch).toBe("main");
    expect(bca.profile).toBe(".pi/pipeline.yaml");
    expect(bca.language).toBe("typescript");
    expect(bca.description).toBe("Build-Code-Audit pipeline");
  });

  test("applies defaults for branch and profile", () => {
    const registry = parseProjectRegistry(VALID_YAML);
    const gastown = registry.projects.gastown;
    expect(gastown.branch).toBe("main");
    expect(gastown.profile).toBe(".pi/pipeline.yaml");
  });

  test("description is optional", () => {
    const registry = parseProjectRegistry(`
default: myproj
projects:
  myproj:
    repo: https://github.com/test/myproj.git
    language: python
`);
    expect(registry.projects.myproj.description).toBeUndefined();
  });

  test("rejects when default project is not in projects map", () => {
    expect(() =>
      parseProjectRegistry(`
default: nonexistent
projects:
  bca:
    repo: https://github.com/test/bca.git
    language: typescript
`),
    ).toThrow();
  });

  test("rejects missing repo URL", () => {
    expect(() =>
      parseProjectRegistry(`
default: bca
projects:
  bca:
    language: typescript
`),
    ).toThrow();
  });

  test("rejects invalid repo URL", () => {
    expect(() =>
      parseProjectRegistry(`
default: bca
projects:
  bca:
    repo: not-a-url
    language: typescript
`),
    ).toThrow();
  });

  test("rejects missing language", () => {
    expect(() =>
      parseProjectRegistry(`
default: bca
projects:
  bca:
    repo: https://github.com/test/bca.git
`),
    ).toThrow();
  });

  test("rejects empty projects map", () => {
    expect(() =>
      parseProjectRegistry(`
default: bca
projects: {}
`),
    ).toThrow();
  });

  test("rejects empty config", () => {
    expect(() => parseProjectRegistry("")).toThrow();
  });
});

describe("getProject", () => {
  const registry = parseProjectRegistry(VALID_YAML);

  test("returns named project", () => {
    const proj = getProject(registry, "gastown");
    expect(proj.name).toBe("gastown");
    expect(proj.language).toBe("go");
  });

  test("returns default project when no name given", () => {
    const proj = getProject(registry);
    expect(proj.name).toBe("bca");
    expect(proj.language).toBe("typescript");
  });

  test("throws for unknown project", () => {
    expect(() => getProject(registry, "unknown")).toThrow(ProjectRegistryLoadError);
  });
});

describe("loadProjectRegistry", () => {
  const tmpBase = join(tmpdir(), `bca-project-test-${Date.now()}`);

  test("loads valid YAML from file path", async () => {
    const dir = join(tmpBase, "valid");
    await mkdir(dir, { recursive: true });
    const filePath = join(dir, "projects.yaml");
    await writeFile(filePath, VALID_YAML);

    const registry = await loadProjectRegistry(filePath);
    expect(registry.default).toBe("bca");
    expect(Object.keys(registry.projects)).toHaveLength(2);
  });

  test("throws ProjectRegistryLoadError for missing file", async () => {
    try {
      await loadProjectRegistry("/nonexistent/projects.yaml");
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(ProjectRegistryLoadError);
      expect((err as ProjectRegistryLoadError).message).toContain("Cannot read");
    }
  });

  test("throws ProjectRegistryLoadError for invalid YAML", async () => {
    const dir = join(tmpBase, "invalid-yaml");
    await mkdir(dir, { recursive: true });
    const filePath = join(dir, "projects.yaml");
    await writeFile(filePath, "{{{not valid yaml");

    try {
      await loadProjectRegistry(filePath);
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(ProjectRegistryLoadError);
      expect((err as ProjectRegistryLoadError).message).toContain("Invalid YAML");
    }
  });

  test("throws ProjectRegistryLoadError for schema violations", async () => {
    const dir = join(tmpBase, "bad-schema");
    await mkdir(dir, { recursive: true });
    const filePath = join(dir, "projects.yaml");
    await writeFile(filePath, `default: x\nprojects: {}`);

    try {
      await loadProjectRegistry(filePath);
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(ProjectRegistryLoadError);
      expect((err as ProjectRegistryLoadError).message).toContain("Validation failed");
    }
  });

  test("cleanup tmp", async () => {
    await rm(tmpBase, { recursive: true, force: true });
  });
});

describe("ProjectRegistrySchema", () => {
  test("safeParse returns success for valid input", () => {
    const result = ProjectRegistrySchema.safeParse({
      default: "bca",
      projects: {
        bca: { repo: "https://github.com/test/bca.git", language: "typescript" },
      },
    });
    expect(result.success).toBe(true);
  });

  test("safeParse returns error for invalid input", () => {
    const result = ProjectRegistrySchema.safeParse({ default: "x", projects: {} });
    expect(result.success).toBe(false);
  });
});
