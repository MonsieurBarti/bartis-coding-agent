import { z } from "zod";

/**
 * Known tools available to the agent.
 * Deterministic nodes use a subset; agent nodes get the curated list.
 */
export const ToolName = z.enum([
  "read",
  "write",
  "edit",
  "bash",
  "grep",
  "glob",
]);

export const ProjectSchema = z.object({
  language: z.string(),
  packageManager: z.string().default("npm"),
});

export const CommandsSchema = z.object({
  install: z.string().optional(),
  lint: z.string().optional(),
  test: z.string().optional(),
  build: z.string().optional(),
  format: z.string().optional(),
  typecheck: z.string().optional(),
});

export const GitSchema = z.object({
  baseBranch: z.string().default("main"),
  commitPrefix: z.string().default(""),
});

export const PrSchema = z.object({
  template: z.string().optional(),
});

export const DEFAULT_TOOLS: readonly ToolName[] = ["read", "write", "edit", "bash", "grep", "glob"] as const;

export const PipelineProfileSchema = z.object({
  project: ProjectSchema,
  commands: CommandsSchema.default({}),
  tools: z.array(ToolName).default([...DEFAULT_TOOLS]),
  rules: z.array(z.string()).default([]),
  git: GitSchema.default({ baseBranch: "main", commitPrefix: "" }),
  pr: PrSchema.default({}),
});

export type ToolName = z.infer<typeof ToolName>;
export type ProjectConfig = z.infer<typeof ProjectSchema>;
export type CommandsConfig = z.infer<typeof CommandsSchema>;
export type GitConfig = z.infer<typeof GitSchema>;
export type PrConfig = z.infer<typeof PrSchema>;
export type PipelineProfile = z.infer<typeof PipelineProfileSchema>;
