import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { type PipelineProfile, PipelineProfileSchema } from "./schema";

/** Default config file path relative to project root */
const CONFIG_FILENAME = ".pi/pipeline.yaml";

export class ProfileLoadError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "ProfileLoadError";
  }
}

/**
 * Load and validate a pipeline profile from a YAML file.
 *
 * @param projectRoot - Absolute path to the project root
 * @param configPath  - Override config file path (relative to projectRoot or absolute)
 * @returns Validated PipelineProfile with defaults applied
 * @throws ProfileLoadError if the file can't be read or validation fails
 */
export async function loadProfile(
  projectRoot: string,
  configPath?: string,
): Promise<PipelineProfile> {
  const filePath = resolve(projectRoot, configPath ?? CONFIG_FILENAME);

  let raw: string;
  try {
    raw = await readFile(filePath, "utf-8");
  } catch (err: unknown) {
    throw new ProfileLoadError(`Cannot read config at ${filePath}`, err);
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (err: unknown) {
    throw new ProfileLoadError(`Invalid YAML in ${filePath}`, err);
  }

  const result = PipelineProfileSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new ProfileLoadError(`Validation failed for ${filePath}:\n${issues}`);
  }

  return result.data;
}

/**
 * Parse a raw YAML string into a validated profile.
 * Useful for testing or inline config.
 */
export function parseProfile(yamlContent: string): PipelineProfile {
  const parsed = parseYaml(yamlContent);
  return PipelineProfileSchema.parse(parsed);
}
