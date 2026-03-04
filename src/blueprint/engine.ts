import { parse as parseYaml } from "yaml";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { BlueprintSchema, type Blueprint, type NodeState } from "./schema";
import { topoSort } from "./topo";
import {
  assembleContext,
  SubprocessExecutor,
  type CodeGraphExecutor,
  type AssembledContext,
} from "./context";

export interface EngineEvents {
  onNodeStart?: (id: string, node: NodeState) => void;
  onNodeEnd?: (id: string, node: NodeState) => void;
  onContextAssembled?: (id: string, context: AssembledContext) => void;
  onPlanWritten?: (id: string, planFile: string, plan: string) => void;
}

export interface EngineOptions {
  events?: EngineEvents;
  /** Project root path for code-graph queries. Required if any agent node has context. */
  projectPath?: string;
  /** Override the code-graph executor (default: SubprocessExecutor). */
  codeGraphExecutor?: CodeGraphExecutor;
}

export interface EngineResult {
  blueprint: string;
  states: Map<string, NodeState>;
  success: boolean;
}

/**
 * Parse and validate a YAML blueprint string.
 */
export function parseBlueprint(yaml: string): Blueprint {
  const parsed = parseYaml(yaml);
  return BlueprintSchema.parse(parsed);
}

/**
 * Load a blueprint from a YAML file.
 */
export async function loadBlueprint(path: string): Promise<Blueprint> {
  const raw = await readFile(path, "utf-8");
  return parseBlueprint(raw);
}

/**
 * Execute a blueprint: run nodes in topological order,
 * skip downstream nodes when a dependency fails.
 *
 * Agent nodes with `context` config get code-graph queries
 * assembled and prepended to their prompt before execution.
 */
export async function execute(
  blueprint: Blueprint,
  optionsOrEvents?: EngineOptions | EngineEvents,
): Promise<EngineResult> {
  // Support legacy (events-only) and new (options) signatures
  const options: EngineOptions =
    optionsOrEvents && ("events" in optionsOrEvents || "projectPath" in optionsOrEvents || "codeGraphExecutor" in optionsOrEvents)
      ? optionsOrEvents as EngineOptions
      : { events: optionsOrEvents as EngineEvents | undefined };

  const { events, projectPath, codeGraphExecutor } = options;
  const order = topoSort(blueprint);

  const states = new Map<string, NodeState>();
  for (const id of order) {
    states.set(id, {
      id,
      node: blueprint.nodes[id],
      status: "pending",
    });
  }

  for (const id of order) {
    const state = states.get(id)!;
    const node = state.node;

    // Check if any dependency failed or was skipped
    const depsFailed = node.deps.some((dep) => {
      const depStatus = states.get(dep)!.status;
      return depStatus === "failure" || depStatus === "skipped";
    });

    // Cleanup nodes always run, even when dependencies failed
    const isCleanup = node.type === "deterministic" && node.cleanup;

    if (depsFailed && !isCleanup) {
      state.status = "skipped";
      events?.onNodeEnd?.(id, state);
      continue;
    }

    state.status = "running";
    events?.onNodeStart?.(id, state);

    try {
      if (node.type === "deterministic") {
        await runDeterministic(node.command);
      } else if (node.type === "git-setup") {
        await runGitSetup(node.branch, node.baseBranch, node.worktree);
      } else if (node.type === "ci-gate") {
        await runCiGate(node.test, node.autofix, node.maxRounds, state);
      } else if (node.type === "understand") {
        const executor = codeGraphExecutor ?? new SubprocessExecutor();
        const resolvedPath = projectPath ?? process.cwd();
        const assembled = await assembleContext(
          node.context,
          resolvedPath,
          executor,
        );
        events?.onContextAssembled?.(id, assembled);
        const plan = await runUnderstand(
          node.task,
          assembled,
          node.planFile,
        );
        events?.onPlanWritten?.(id, node.planFile, plan);
      } else {
        // Agent node — assemble context if configured
        let prompt = node.prompt;
        if (node.context) {
          const executor = codeGraphExecutor ?? new SubprocessExecutor();
          const resolvedPath = projectPath ?? process.cwd();
          const assembled = await assembleContext(
            node.context,
            resolvedPath,
            executor,
          );
          events?.onContextAssembled?.(id, assembled);
          if (assembled.text) {
            prompt = `${assembled.text}\n\n${prompt}`;
          }
        }
        await runAgent(prompt);
      }
      state.status = "success";
    } catch (err: unknown) {
      state.status = "failure";
      state.error = err instanceof Error ? err.message : String(err);
    }

    events?.onNodeEnd?.(id, state);
  }

  const success = [...states.values()].every(
    (s) => s.status === "success",
  );

  return { blueprint: blueprint.name, states, success };
}

/** Run a shell command. Throws on non-zero exit. */
async function runDeterministic(command: string): Promise<void> {
  const proc = Bun.spawn(["sh", "-c", command], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, , stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  if (exitCode !== 0) {
    throw new Error(
      `Command failed (exit ${exitCode}): ${command}${stderr.trim() ? `\n${stderr.trim()}` : ""}`,
    );
  }
}

/**
 * Create a feature branch and optionally set up a git worktree.
 * Deterministic — no LLM needed.
 */
async function runGitSetup(
  branch: string,
  baseBranch: string,
  worktree?: string,
): Promise<void> {
  await git(["fetch", "origin", baseBranch]);

  if (worktree) {
    await git(["worktree", "add", "-b", branch, worktree, `origin/${baseBranch}`]);
  } else {
    await git(["checkout", "-b", branch, `origin/${baseBranch}`]);
  }
}

/** Run a git command. Throws on non-zero exit. */
async function git(args: string[]): Promise<void> {
  const proc = Bun.spawn(["git", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, , stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  if (exitCode !== 0) {
    throw new Error(
      `git ${args[0]} failed (exit ${exitCode})${stderr.trim() ? `\n${stderr.trim()}` : ""}`,
    );
  }
}

/**
 * Run a CI gate: test → autofix → retest loop, up to maxRounds.
 * Throws if tests still fail after all rounds are exhausted.
 */
async function runCiGate(
  testCmd: string,
  autofixCmd: string,
  maxRounds: number,
  state: NodeState,
): Promise<void> {
  for (let round = 1; round <= maxRounds; round++) {
    state.rounds = round;
    try {
      await runDeterministic(testCmd);
      return; // Tests passed — success
    } catch (testErr: unknown) {
      if (round === maxRounds) {
        throw new Error(
          `CI gate failed after ${maxRounds} rounds: ${testErr instanceof Error ? testErr.message : String(testErr)}`,
        );
      }
      // Tests failed but we have rounds left — run autofix, then loop
      try {
        await runDeterministic(autofixCmd);
      } catch (fixErr: unknown) {
        throw new Error(
          `Autofix failed in round ${round}: ${fixErr instanceof Error ? fixErr.message : String(fixErr)}`,
        );
      }
    }
  }
}

/**
 * Run an understand node: build a plan prompt from task + assembled context,
 * invoke the agent, and write the plan file.
 *
 * The agent receives the codebase context and task description, then produces
 * a structured plan. The plan is written to planFile for downstream nodes.
 */
async function runUnderstand(
  task: string,
  assembled: AssembledContext,
  planFile: string,
): Promise<string> {
  const prompt = buildUnderstandPrompt(task, assembled);
  const plan = await runAgent(prompt);
  await mkdir(dirname(planFile), { recursive: true });
  await writeFile(planFile, plan, "utf-8");
  return plan;
}

/**
 * Build the prompt for an understand node.
 * Combines pre-hydrated codebase context with the task description
 * and instructions to produce a structured implementation plan.
 */
export function buildUnderstandPrompt(
  task: string,
  assembled: AssembledContext,
): string {
  const sections: string[] = [];

  if (assembled.text) {
    sections.push(assembled.text);
  }

  sections.push(`# Task\n\n${task}`);

  sections.push(`# Instructions

Analyze the task above using the codebase context provided. Produce a structured
implementation plan that includes:

1. **Summary**: One-paragraph overview of what needs to change
2. **Files to modify**: List each file with a brief description of changes
3. **Files to create**: List any new files needed
4. **Implementation steps**: Ordered list of concrete steps
5. **Testing strategy**: How to verify the implementation works
6. **Risks and open questions**: Anything that needs clarification`);

  return sections.join("\n\n");
}

/** Stub for agent node execution. Will invoke Pi SDK later. */
async function runAgent(_prompt: string): Promise<string> {
  // TODO: invoke Pi SDK agent loop
  // For now, agent nodes return empty plan
  return "";
}
