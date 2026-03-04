import { parse as parseYaml } from "yaml";
import { readFile } from "node:fs/promises";
import { BlueprintSchema, type Blueprint, type NodeState } from "./schema";
import { topoSort } from "./topo";

export interface EngineEvents {
  onNodeStart?: (id: string, node: NodeState) => void;
  onNodeEnd?: (id: string, node: NodeState) => void;
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
 */
export async function execute(
  blueprint: Blueprint,
  events?: EngineEvents,
): Promise<EngineResult> {
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
      } else if (node.type === "agent") {
        await runAgent(node.prompt);
      } else if (node.type === "ci-gate") {
        await runCiGate(node.test, node.autofix, node.maxRounds, state);
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

/** Stub for agent node execution. Will invoke Pi SDK later. */
async function runAgent(_prompt: string): Promise<void> {
  // TODO: invoke Pi SDK agent loop
  // For now, agent nodes always succeed
}
