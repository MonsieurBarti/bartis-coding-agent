import { z } from "zod";
import { ContextConfigSchema } from "./context";

export const NodeType = z.enum([
  "deterministic",
  "agent",
  "git-setup",
  "ci-gate",
  "understand",
  "fix",
]);

export const BlueprintNodeSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("deterministic"),
    command: z.string(),
    deps: z.array(z.string()).default([]),
    cleanup: z.boolean().default(false),
  }),
  z.object({
    type: z.literal("agent"),
    prompt: z.string(),
    deps: z.array(z.string()).default([]),
    context: ContextConfigSchema.optional(),
    /** Max feedback iterations (agent run + lint/typecheck check). Default 3. */
    maxIterations: z.number().int().min(1).max(10).default(3),
  }),
  z.object({
    type: z.literal("git-setup"),
    branch: z.string(),
    baseBranch: z.string().default("main"),
    worktree: z.string().optional(),
    deps: z.array(z.string()).default([]),
  }),
  z.object({
    type: z.literal("ci-gate"),
    test: z.string(),
    autofix: z.string(),
    maxRounds: z.number().int().min(1).max(10).default(2),
    deps: z.array(z.string()).default([]),
  }),
  z.object({
    type: z.literal("understand"),
    task: z.string(),
    context: ContextConfigSchema,
    planFile: z.string(),
    deps: z.array(z.string()).default([]),
  }),
  z.object({
    type: z.literal("fix"),
    test: z.string(),
    prompt: z.string(),
    maxRetries: z.number().int().min(1).max(5).default(1),
    deps: z.array(z.string()).default([]),
    context: ContextConfigSchema.optional(),
  }),
]);

export const BlueprintSchema = z.object({
  name: z.string(),
  nodes: z.record(z.string(), BlueprintNodeSchema),
});

export type NodeType = z.infer<typeof NodeType>;
export type BlueprintNode = z.infer<typeof BlueprintNodeSchema>;
export type Blueprint = z.infer<typeof BlueprintSchema>;

export const NodeStatus = z.enum(["pending", "running", "success", "failure", "skipped"]);
export type NodeStatus = z.infer<typeof NodeStatus>;

export interface NodeState {
  id: string;
  node: BlueprintNode;
  status: NodeStatus;
  error?: string;
  /** For ci-gate nodes: number of test/fix rounds executed */
  rounds?: number;
  /** For agent nodes: number of feedback iterations executed */
  iterations?: number;
}
