import { describe, expect, test } from "bun:test";
import { parseProfile } from "../../profile";
import { type AgentRunner, type Blueprint, execute, parseBlueprint } from "../index";

/** Tracks calls to the mock runner. */
interface RunCall {
  prompt: string;
  cwd?: string;
}

/** Create a mock runner that records calls and optionally throws. */
function mockRunner(behavior?: (call: RunCall, callIndex: number) => void): {
  runner: AgentRunner;
  calls: RunCall[];
} {
  const calls: RunCall[] = [];
  return {
    runner: {
      async run(prompt, options) {
        const call = { prompt, cwd: options?.cwd };
        calls.push(call);
        behavior?.(call, calls.length - 1);
      },
    },
    calls,
  };
}

/** Build a minimal profile with lint/typecheck commands. */
function makeProfile(commands: { lint?: string; typecheck?: string }) {
  const lines = ["project:", "  language: typescript"];
  if (commands.lint || commands.typecheck) {
    lines.push("commands:");
    if (commands.lint) lines.push(`  lint: "${commands.lint}"`);
    if (commands.typecheck) lines.push(`  typecheck: "${commands.typecheck}"`);
  }
  return parseProfile(lines.join("\n"));
}

describe("agent node execution", () => {
  test("no-op when no runner provided (backward compat)", async () => {
    const bp = parseBlueprint(`
name: stub-test
nodes:
  think:
    type: agent
    prompt: "Think about it"
`);
    const result = await execute(bp);
    expect(result.success).toBe(true);
    expect(result.states.get("think")!.status).toBe("success");
  });

  test("runs agent once when runner provided but no profile", async () => {
    const { runner, calls } = mockRunner();
    const bp = parseBlueprint(`
name: single-shot
nodes:
  impl:
    type: agent
    prompt: "Implement the feature"
`);
    const result = await execute(bp, { agentRunner: runner });
    expect(result.success).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].prompt).toContain("Implement the feature");
  });

  test("succeeds on first iteration when feedback passes", async () => {
    const { runner, calls } = mockRunner();
    const profile = makeProfile({ lint: "echo ok", typecheck: "echo ok" });

    const bp = parseBlueprint(`
name: feedback-pass
nodes:
  impl:
    type: agent
    prompt: "Fix the bug"
`);
    const result = await execute(bp, { agentRunner: runner, profile });
    expect(result.success).toBe(true);
    expect(calls).toHaveLength(1);
    expect(result.states.get("impl")!.iterations).toBe(1);
  });

  test("iterates when feedback fails then passes", async () => {
    // Use a temp file as state: lint fails first, agent "fixes" it, lint passes
    const marker = `/tmp/bca-agent-test-${Date.now()}`;
    const { runner, calls } = mockRunner((_call, idx) => {
      // On second call, create the marker file to make lint pass
      if (idx === 1) {
        Bun.spawnSync(["touch", marker]);
      }
    });

    const profile = makeProfile({ lint: `test -f ${marker}` });

    const bp = parseBlueprint(`
name: feedback-iterate
nodes:
  impl:
    type: agent
    prompt: "Fix the lint errors"
    maxIterations: 3
`);
    try {
      const result = await execute(bp, { agentRunner: runner, profile });
      expect(result.success).toBe(true);
      expect(calls).toHaveLength(2);
      expect(result.states.get("impl")!.iterations).toBe(2);
      // Second call should include feedback
      expect(calls[1].prompt).toContain("Feedback from iteration 1");
      expect(calls[1].prompt).toContain("lint failed");
    } finally {
      Bun.spawnSync(["rm", "-f", marker]);
    }
  });

  test("fails after maxIterations when feedback never passes", async () => {
    const { runner, calls } = mockRunner();
    const profile = makeProfile({ lint: "echo 'error: bad code' >&2 && exit 1" });

    const bp = parseBlueprint(`
name: feedback-exhaust
nodes:
  impl:
    type: agent
    prompt: "Try to fix"
    maxIterations: 2
`);
    const result = await execute(bp, { agentRunner: runner, profile });
    expect(result.success).toBe(false);
    expect(calls).toHaveLength(2);
    const state = result.states.get("impl")!;
    expect(state.status).toBe("failure");
    expect(state.iterations).toBe(2);
    expect(state.error).toContain("Agent feedback failed after 2 iterations");
    expect(state.error).toContain("lint failed");
  });

  test("fails immediately when runner throws", async () => {
    const { runner } = mockRunner(() => {
      throw new Error("LLM API error");
    });
    const profile = makeProfile({ lint: "echo ok" });

    const bp = parseBlueprint(`
name: runner-fail
nodes:
  impl:
    type: agent
    prompt: "Do something"
`);
    const result = await execute(bp, { agentRunner: runner, profile });
    expect(result.success).toBe(false);
    const state = result.states.get("impl")!;
    expect(state.status).toBe("failure");
    expect(state.error).toContain("LLM API error");
  });

  test("maxIterations defaults to 3", () => {
    const bp = parseBlueprint(`
name: defaults
nodes:
  a:
    type: agent
    prompt: "Do work"
`);
    const node = bp.nodes.a;
    if (node.type === "agent") {
      expect(node.maxIterations).toBe(3);
    }
  });

  test("skips downstream when agent fails", async () => {
    const { runner } = mockRunner(() => {
      throw new Error("boom");
    });

    const bp = parseBlueprint(`
name: skip-downstream
nodes:
  impl:
    type: agent
    prompt: "Implement"
  deploy:
    type: deterministic
    command: "echo deploying"
    deps: [impl]
`);
    const result = await execute(bp, { agentRunner: runner });
    expect(result.states.get("impl")!.status).toBe("failure");
    expect(result.states.get("deploy")!.status).toBe("skipped");
  });

  test("passes cwd to runner", async () => {
    const { runner, calls } = mockRunner();
    const bp = parseBlueprint(`
name: cwd-test
nodes:
  impl:
    type: agent
    prompt: "Work"
`);
    await execute(bp, { agentRunner: runner, projectPath: "/my/project" });
    expect(calls[0].cwd).toBe("/my/project");
  });

  test("context is prepended to prompt before runner receives it", async () => {
    const { runner, calls } = mockRunner();
    const bp: Blueprint = {
      name: "context-agent",
      nodes: {
        impl: {
          type: "agent",
          prompt: "Implement the feature",
          deps: [],
          maxIterations: 3,
          context: {
            queries: [{ kind: "stats" }],
          },
        },
      },
    };

    const mockExecutor = {
      async execute() {
        return "Files: 42\nSymbols: 200";
      },
    };

    await execute(bp, {
      agentRunner: runner,
      codeGraphExecutor: mockExecutor,
      projectPath: "/test",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].prompt).toContain("Files: 42");
    expect(calls[0].prompt).toContain("Implement the feature");
  });

  test("singular iteration in error message", async () => {
    const { runner } = mockRunner();
    const profile = makeProfile({ lint: "exit 1" });

    const bp = parseBlueprint(`
name: singular
nodes:
  impl:
    type: agent
    prompt: "Fix"
    maxIterations: 1
`);
    const result = await execute(bp, { agentRunner: runner, profile });
    expect(result.states.get("impl")!.error).toContain("after 1 iteration:");
    expect(result.states.get("impl")!.error).not.toContain("iterations:");
  });
});
