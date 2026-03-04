import { z } from "zod";

export const NodeType = z.enum(["deterministic", "agent", "git-setup"]);

export const BlueprintNodeSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("deterministic"),
    command: z.string(),
    deps: z.array(z.string()).default([]),
  }),
  z.object({
    type: z.literal("agent"),
    prompt: z.string(),
    deps: z.array(z.string()).default([]),
  }),
  z.object({
    type: z.literal("git-setup"),
    branch: z.string(),
    baseBranch: z.string().default("main"),
    worktree: z.string().optional(),
    deps: z.array(z.string()).default([]),
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
}
