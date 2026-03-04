import type { Blueprint } from "../blueprint";

/**
 * Build the default coding pipeline blueprint for a task.
 *
 * The pipeline is a simple DAG:
 *   understand → implement → verify
 *
 * - understand: Analyze the codebase and produce an implementation plan
 * - implement:  Agent node that executes the plan
 * - verify:     Run tests to verify the implementation
 *
 * @param task - Human-readable task description
 * @param testCmd - Shell command to run tests (from profile.commands.test)
 */
export function buildDefaultBlueprint(
  task: string,
  testCmd?: string,
): Blueprint {
  const nodes: Blueprint["nodes"] = {
    understand: {
      type: "understand" as const,
      task,
      context: {
        queries: [
          { kind: "stats" as const },
          { kind: "structure" as const },
        ],
      },
      planFile: ".pi/plan.md",
      deps: [],
    },
    implement: {
      type: "agent" as const,
      prompt: task,
      deps: ["understand"],
      maxIterations: 3,
    },
  };

  if (testCmd) {
    nodes.verify = {
      type: "deterministic" as const,
      command: testCmd,
      deps: ["implement"],
      cleanup: false,
    };
  }

  return { name: "default-coding-pipeline", nodes };
}
