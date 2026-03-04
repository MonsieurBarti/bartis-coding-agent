import { describe, test, expect } from "bun:test";
import {
  BlueprintSchema,
  parseBlueprint,
  topoSort,
  execute,
  CycleError,
  type Blueprint,
  type CodeGraphExecutor,
  type ContextQuery,
  type AssembledContext,
} from "../index";

const SIMPLE_YAML = `
name: test-pipeline
nodes:
  install:
    type: deterministic
    command: "echo installed"
  lint:
    type: deterministic
    command: "echo linted"
    deps: [install]
  review:
    type: agent
    prompt: "Review the code"
    deps: [lint]
`;

describe("BlueprintSchema", () => {
  test("parses valid blueprint", () => {
    const bp = parseBlueprint(SIMPLE_YAML);
    expect(bp.name).toBe("test-pipeline");
    expect(Object.keys(bp.nodes)).toEqual(["install", "lint", "review"]);
    expect(bp.nodes.install.type).toBe("deterministic");
    expect(bp.nodes.review.type).toBe("agent");
  });

  test("rejects missing name", () => {
    expect(() =>
      parseBlueprint(`
nodes:
  a:
    type: deterministic
    command: echo hi
`),
    ).toThrow();
  });

  test("rejects unknown node type", () => {
    expect(() =>
      parseBlueprint(`
name: bad
nodes:
  a:
    type: unknown
    command: echo hi
`),
    ).toThrow();
  });

  test("defaults deps to empty array", () => {
    const bp = parseBlueprint(`
name: no-deps
nodes:
  a:
    type: deterministic
    command: echo hi
`);
    expect(bp.nodes.a.deps).toEqual([]);
  });
});

describe("topoSort", () => {
  test("sorts linear chain", () => {
    const bp = parseBlueprint(SIMPLE_YAML);
    const order = topoSort(bp);
    expect(order.indexOf("install")).toBeLessThan(order.indexOf("lint"));
    expect(order.indexOf("lint")).toBeLessThan(order.indexOf("review"));
  });

  test("handles parallel nodes", () => {
    const bp = parseBlueprint(`
name: parallel
nodes:
  a:
    type: deterministic
    command: echo a
  b:
    type: deterministic
    command: echo b
  c:
    type: deterministic
    command: echo c
    deps: [a, b]
`);
    const order = topoSort(bp);
    expect(order.indexOf("a")).toBeLessThan(order.indexOf("c"));
    expect(order.indexOf("b")).toBeLessThan(order.indexOf("c"));
  });

  test("throws on cycle", () => {
    const bp: Blueprint = {
      name: "cyclic",
      nodes: {
        a: { type: "deterministic", command: "echo a", deps: ["b"], cleanup: false },
        b: { type: "deterministic", command: "echo b", deps: ["a"], cleanup: false },
      },
    };
    expect(() => topoSort(bp)).toThrow(CycleError);
  });

  test("throws on unknown dependency", () => {
    const bp: Blueprint = {
      name: "bad-dep",
      nodes: {
        a: { type: "deterministic", command: "echo a", deps: ["missing"], cleanup: false },
      },
    };
    expect(() => topoSort(bp)).toThrow(/unknown node "missing"/);
  });
});

describe("execute", () => {
  test("runs all nodes successfully", async () => {
    const bp = parseBlueprint(SIMPLE_YAML);
    const result = await execute(bp);
    expect(result.success).toBe(true);
    expect(result.states.get("install")!.status).toBe("success");
    expect(result.states.get("lint")!.status).toBe("success");
    expect(result.states.get("review")!.status).toBe("success");
  });

  test("skips downstream on failure", async () => {
    const bp = parseBlueprint(`
name: fail-test
nodes:
  bad:
    type: deterministic
    command: "exit 1"
  after:
    type: deterministic
    command: "echo should-not-run"
    deps: [bad]
`);
    const result = await execute(bp);
    expect(result.success).toBe(false);
    expect(result.states.get("bad")!.status).toBe("failure");
    expect(result.states.get("after")!.status).toBe("skipped");
  });

  test("fires events in order", async () => {
    const bp = parseBlueprint(`
name: events
nodes:
  a:
    type: deterministic
    command: "echo a"
`);
    const log: string[] = [];
    await execute(bp, {
      onNodeStart: (id) => log.push(`start:${id}`),
      onNodeEnd: (id) => log.push(`end:${id}`),
    });
    expect(log).toEqual(["start:a", "end:a"]);
  });

  test("agent nodes succeed (stub)", async () => {
    const bp = parseBlueprint(`
name: agent-test
nodes:
  think:
    type: agent
    prompt: "Think about it"
`);
    const result = await execute(bp);
    expect(result.success).toBe(true);
    expect(result.states.get("think")!.status).toBe("success");
  });

  test("cleanup node runs when dependency fails", async () => {
    const bp = parseBlueprint(`
name: cleanup-on-fail
nodes:
  build:
    type: deterministic
    command: "exit 1"
  teardown:
    type: deterministic
    command: "echo cleaned"
    deps: [build]
    cleanup: true
`);
    const result = await execute(bp);
    expect(result.success).toBe(false);
    expect(result.states.get("build")!.status).toBe("failure");
    expect(result.states.get("teardown")!.status).toBe("success");
  });

  test("cleanup node runs when dependency succeeds", async () => {
    const bp = parseBlueprint(`
name: cleanup-on-success
nodes:
  build:
    type: deterministic
    command: "echo built"
  teardown:
    type: deterministic
    command: "echo cleaned"
    deps: [build]
    cleanup: true
`);
    const result = await execute(bp);
    expect(result.success).toBe(true);
    expect(result.states.get("build")!.status).toBe("success");
    expect(result.states.get("teardown")!.status).toBe("success");
  });

  test("cleanup node runs when transitive dependency is skipped", async () => {
    const bp = parseBlueprint(`
name: cleanup-transitive
nodes:
  first:
    type: deterministic
    command: "exit 1"
  second:
    type: deterministic
    command: "echo skipped"
    deps: [first]
  teardown:
    type: deterministic
    command: "echo cleaned"
    deps: [second]
    cleanup: true
`);
    const result = await execute(bp);
    expect(result.states.get("first")!.status).toBe("failure");
    expect(result.states.get("second")!.status).toBe("skipped");
    expect(result.states.get("teardown")!.status).toBe("success");
  });

  test("non-cleanup node still skips on dep failure", async () => {
    const bp = parseBlueprint(`
name: no-cleanup-skip
nodes:
  bad:
    type: deterministic
    command: "exit 1"
  normal:
    type: deterministic
    command: "echo should-not-run"
    deps: [bad]
`);
    const result = await execute(bp);
    expect(result.states.get("normal")!.status).toBe("skipped");
  });

  test("cleanup defaults to false", () => {
    const bp = parseBlueprint(`
name: default-cleanup
nodes:
  a:
    type: deterministic
    command: echo hi
`);
    const node = bp.nodes.a;
    if (node.type === "deterministic") {
      expect(node.cleanup).toBe(false);
    }
  });

  test("captures error message on failure", async () => {
    const bp = parseBlueprint(`
name: err-capture
nodes:
  fail:
    type: deterministic
    command: "echo boom >&2 && exit 42"
`);
    const result = await execute(bp);
    const state = result.states.get("fail")!;
    expect(state.status).toBe("failure");
    expect(state.error).toContain("exit 42");
    expect(state.error).toContain("boom");
  });

  test("backward compat: accepts events as second argument", async () => {
    const bp = parseBlueprint(`
name: compat
nodes:
  a:
    type: deterministic
    command: "echo compat"
`);
    const log: string[] = [];
    const result = await execute(bp, {
      onNodeStart: (id) => log.push(`start:${id}`),
      onNodeEnd: (id) => log.push(`end:${id}`),
    });
    expect(result.success).toBe(true);
    expect(log).toEqual(["start:a", "end:a"]);
  });

  test("assembles context before agent node", async () => {
    const bp: Blueprint = {
      name: "context-test",
      nodes: {
        think: {
          type: "agent",
          prompt: "Think about the code",
          deps: [],
          context: {
            queries: [{ kind: "stats" }],
          },
        },
      },
    };

    const mockExecutor: CodeGraphExecutor = {
      async execute(query: ContextQuery) {
        if (query.kind === "stats") return "Files: 10\nSymbols: 50";
        return "";
      },
    };

    let assembledCtx: AssembledContext | undefined;
    const result = await execute(bp, {
      codeGraphExecutor: mockExecutor,
      projectPath: "/test",
      events: {
        onContextAssembled: (_id, ctx) => {
          assembledCtx = ctx;
        },
      },
    });

    expect(result.success).toBe(true);
    expect(assembledCtx).toBeDefined();
    expect(assembledCtx!.text).toContain("Project Stats");
    expect(assembledCtx!.text).toContain("Files: 10");
    expect(assembledCtx!.results).toHaveLength(1);
  });

  test("agent nodes without context still work", async () => {
    const bp = parseBlueprint(`
name: no-context
nodes:
  agent:
    type: agent
    prompt: "Do something"
`);
    const result = await execute(bp);
    expect(result.success).toBe(true);
  });

  test("parses agent node with context from YAML", () => {
    const bp = parseBlueprint(`
name: with-context
nodes:
  analyze:
    type: agent
    prompt: "Analyze the code"
    context:
      queries:
        - kind: stats
        - kind: structure
          path: src
          depth: 2
        - kind: file_summary
          path: src/index.ts
`);
    const node = bp.nodes.analyze;
    expect(node.type).toBe("agent");
    if (node.type === "agent") {
      expect(node.context).toBeDefined();
      expect(node.context!.queries).toHaveLength(3);
      expect(node.context!.queries[0].kind).toBe("stats");
      expect(node.context!.queries[1].kind).toBe("structure");
    }
  });
});

describe("ci-gate node", () => {
  test("passes on first round when tests succeed", async () => {
    const bp = parseBlueprint(`
name: gate-pass
nodes:
  gate:
    type: ci-gate
    test: "echo tests-pass"
    autofix: "echo fix"
`);
    const result = await execute(bp);
    expect(result.success).toBe(true);
    const state = result.states.get("gate")!;
    expect(state.status).toBe("success");
    expect(state.rounds).toBe(1);
  });

  test("applies autofix and passes on round 2", async () => {
    // Use a temp file as state: first run fails, autofix creates marker, second run passes
    const marker = `/tmp/bca-cigate-test-${Date.now()}`;
    const bp = parseBlueprint(`
name: gate-fix
nodes:
  gate:
    type: ci-gate
    test: "test -f ${marker}"
    autofix: "touch ${marker}"
`);
    try {
      const result = await execute(bp);
      expect(result.success).toBe(true);
      const state = result.states.get("gate")!;
      expect(state.status).toBe("success");
      expect(state.rounds).toBe(2);
    } finally {
      await Bun.spawn(["rm", "-f", marker]).exited;
    }
  });

  test("fails after max rounds exhausted", async () => {
    const bp = parseBlueprint(`
name: gate-fail
nodes:
  gate:
    type: ci-gate
    test: "exit 1"
    autofix: "echo fixing"
    maxRounds: 2
`);
    const result = await execute(bp);
    expect(result.success).toBe(false);
    const state = result.states.get("gate")!;
    expect(state.status).toBe("failure");
    expect(state.error).toContain("CI gate failed after 2 rounds");
    expect(state.rounds).toBe(2);
  });

  test("fails immediately if autofix command fails", async () => {
    const bp = parseBlueprint(`
name: gate-autofix-fail
nodes:
  gate:
    type: ci-gate
    test: "exit 1"
    autofix: "exit 1"
    maxRounds: 2
`);
    const result = await execute(bp);
    expect(result.success).toBe(false);
    const state = result.states.get("gate")!;
    expect(state.status).toBe("failure");
    expect(state.error).toContain("Autofix failed in round 1");
  });

  test("defaults maxRounds to 2", () => {
    const bp = parseBlueprint(`
name: gate-defaults
nodes:
  gate:
    type: ci-gate
    test: "echo test"
    autofix: "echo fix"
`);
    const node = bp.nodes.gate;
    expect(node.type).toBe("ci-gate");
    if (node.type === "ci-gate") {
      expect(node.maxRounds).toBe(2);
    }
  });

  test("skips downstream nodes when gate fails", async () => {
    const bp = parseBlueprint(`
name: gate-skip-downstream
nodes:
  gate:
    type: ci-gate
    test: "exit 1"
    autofix: "echo fix"
    maxRounds: 1
  deploy:
    type: deterministic
    command: "echo deploying"
    deps: [gate]
`);
    const result = await execute(bp);
    expect(result.success).toBe(false);
    expect(result.states.get("gate")!.status).toBe("failure");
    expect(result.states.get("deploy")!.status).toBe("skipped");
  });

  test("works with deps on upstream nodes", async () => {
    const bp = parseBlueprint(`
name: gate-with-deps
nodes:
  build:
    type: deterministic
    command: "echo built"
  gate:
    type: ci-gate
    test: "echo tests-pass"
    autofix: "echo fix"
    deps: [build]
`);
    const result = await execute(bp);
    expect(result.success).toBe(true);
    expect(result.states.get("build")!.status).toBe("success");
    expect(result.states.get("gate")!.status).toBe("success");
  });
});
