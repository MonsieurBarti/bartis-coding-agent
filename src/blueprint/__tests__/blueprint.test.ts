import { describe, test, expect } from "bun:test";
import {
  BlueprintSchema,
  parseBlueprint,
  topoSort,
  execute,
  CycleError,
  type Blueprint,
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
        a: { type: "deterministic", command: "echo a", deps: ["b"] },
        b: { type: "deterministic", command: "echo b", deps: ["a"] },
      },
    };
    expect(() => topoSort(bp)).toThrow(CycleError);
  });

  test("throws on unknown dependency", () => {
    const bp: Blueprint = {
      name: "bad-dep",
      nodes: {
        a: { type: "deterministic", command: "echo a", deps: ["missing"] },
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
});
