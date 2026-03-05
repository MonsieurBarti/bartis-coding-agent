import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { type ProjectEntry, type ProjectRegistry, ProjectRegistrySchema } from "./schema";

const DEFAULT_PATH = resolve(homedir(), ".bca/projects.yaml");

export class ProjectRegistryLoadError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "ProjectRegistryLoadError";
  }
}

/**
 * Load and validate the project registry from a YAML file.
 *
 * @param configPath - Override path (defaults to ~/.bca/projects.yaml)
 * @returns Validated ProjectRegistry with defaults applied
 * @throws ProjectRegistryLoadError if the file can't be read or validation fails
 */
export async function loadProjectRegistry(configPath?: string): Promise<ProjectRegistry> {
  const filePath = configPath ?? DEFAULT_PATH;

  let raw: string;
  try {
    raw = await readFile(filePath, "utf-8");
  } catch (err: unknown) {
    throw new ProjectRegistryLoadError(`Cannot read project registry at ${filePath}`, err);
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (err: unknown) {
    throw new ProjectRegistryLoadError(`Invalid YAML in ${filePath}`, err);
  }

  const result = ProjectRegistrySchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new ProjectRegistryLoadError(`Validation failed for ${filePath}:\n${issues}`);
  }

  return result.data;
}

/**
 * Parse a raw YAML string into a validated project registry.
 * Useful for testing or inline config.
 */
export function parseProjectRegistry(yamlContent: string): ProjectRegistry {
  const parsed = parseYaml(yamlContent);
  return ProjectRegistrySchema.parse(parsed);
}

/**
 * Get a specific project entry by name, or the default project.
 */
export function getProject(
  registry: ProjectRegistry,
  name?: string,
): ProjectEntry & { name: string } {
  const projectName = name ?? registry.default;
  const entry = registry.projects[projectName];
  if (!entry) {
    throw new ProjectRegistryLoadError(`Project "${projectName}" not found in registry`);
  }
  return { ...entry, name: projectName };
}
