import { describe, test, expect, mock } from "bun:test";
import { buildDefaultBlueprint } from "../default-blueprint";
import { dispatch } from "../dispatch";

describe("buildDefaultBlueprint", () => {
  test("builds blueprint with understand and implement nodes", () => {
    const bp = buildDefaultBlueprint("Fix the login bug");
    expect(bp.name).toBe("default-coding-pipeline");
    expect(Object.keys(bp.nodes)).toEqual(["understand", "implement"]);
    expect(bp.nodes.understand.type).toBe("understand");
    expect(bp.nodes.implement.type).toBe("agent");
    expect(bp.nodes.implement.deps).toEqual(["understand"]);
  });

  test("adds verify node when testCmd is provided", () => {
    const bp = buildDefaultBlueprint("Add feature", "bun test");
    expect(Object.keys(bp.nodes)).toEqual(["understand", "implement", "verify"]);
    expect(bp.nodes.verify.type).toBe("deterministic");
    if (bp.nodes.verify.type === "deterministic") {
      expect(bp.nodes.verify.command).toBe("bun test");
      expect(bp.nodes.verify.deps).toEqual(["implement"]);
    }
  });

  test("understand node has context with stats and structure queries", () => {
    const bp = buildDefaultBlueprint("Refactor auth");
    const node = bp.nodes.understand;
    if (node.type === "understand") {
      expect(node.context.queries).toEqual([
        { kind: "stats" },
        { kind: "structure" },
      ]);
      expect(node.planFile).toBe(".pi/plan.md");
    }
  });

  test("implement node uses task as prompt", () => {
    const bp = buildDefaultBlueprint("Write unit tests");
    const node = bp.nodes.implement;
    if (node.type === "agent") {
      expect(node.prompt).toBe("Write unit tests");
      expect(node.maxIterations).toBe(3);
    }
  });
});

describe("dispatch", () => {
  test("throws ProfileLoadError when .pi/pipeline.yaml is missing", async () => {
    try {
      await dispatch({
        task: "Do something",
        projectRoot: "/tmp/nonexistent-project-root",
      });
      expect(true).toBe(false); // should not reach here
    } catch (err: unknown) {
      expect(err instanceof Error).toBe(true);
      expect((err as Error).message).toContain("Cannot read config");
    }
  });
});
