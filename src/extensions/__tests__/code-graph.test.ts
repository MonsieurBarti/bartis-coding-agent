import { describe, expect, test } from "bun:test";
import { registerCodeGraphTools } from "../code-graph";

/**
 * Minimal mock of Pi's ExtensionAPI — just enough to capture registerTool calls.
 */
interface RegisteredTool {
  name: string;
  label: string;
  description: string;
  parameters: unknown;
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal: undefined,
    onUpdate: undefined,
    ctx: { cwd: string },
  ) => Promise<{ content: Array<{ type: string; text: string }> }>;
}

function createMockPi() {
  const tools = new Map<string, RegisteredTool>();
  return {
    tools,
    registerTool(tool: RegisteredTool) {
      tools.set(tool.name, tool);
    },
  };
}

/**
 * Mock Bun.spawn to capture CLI invocations.
 */
function mockSpawn(stdout: string, exitCode: number = 0, stderr: string = "") {
  const calls: string[][] = [];
  const original = Bun.spawn;

  // @ts-expect-error — replacing Bun.spawn for test
  Bun.spawn = (args: string[], _opts?: unknown) => {
    calls.push(args as string[]);
    return {
      exited: Promise.resolve(exitCode),
      stdout: new Response(stdout).body,
      stderr: new Response(stderr).body,
    };
  };

  return {
    calls,
    restore() {
      Bun.spawn = original;
    },
  };
}

describe("code-graph extension", () => {
  describe("registerCodeGraphTools", () => {
    test("registers all 4 tools", () => {
      const pi = createMockPi();
      registerCodeGraphTools(pi as any);
      expect(pi.tools.size).toBe(4);
      expect(pi.tools.has("find_symbol")).toBe(true);
      expect(pi.tools.has("get_context")).toBe(true);
      expect(pi.tools.has("find_references")).toBe(true);
      expect(pi.tools.has("get_impact")).toBe(true);
    });

    test("uses custom binary path", () => {
      const pi = createMockPi();
      registerCodeGraphTools(pi as any, { binary: "/usr/local/bin/cg" });
      // Tools registered — binary used at execute time, not registration
      expect(pi.tools.size).toBe(4);
    });
  });

  describe("find_symbol", () => {
    test("builds correct CLI args", async () => {
      const pi = createMockPi();
      registerCodeGraphTools(pi as any);
      const tool = pi.tools.get("find_symbol")!;

      const spawner = mockSpawn("execute: function @ engine.ts:37");
      try {
        const result = await tool.execute("tc-1", { symbol: "execute" }, undefined, undefined, {
          cwd: "/project",
        });
        expect(spawner.calls).toHaveLength(1);
        expect(spawner.calls[0]).toEqual(["code-graph", "find", "execute", "/project"]);
        expect(result.content[0].text).toContain("execute");
      } finally {
        spawner.restore();
      }
    });

    test("passes kind filter", async () => {
      const pi = createMockPi();
      registerCodeGraphTools(pi as any);
      const tool = pi.tools.get("find_symbol")!;

      const spawner = mockSpawn("execute: function @ engine.ts:37");
      try {
        await tool.execute("tc-1", { symbol: "execute", kind: "function" }, undefined, undefined, {
          cwd: "/project",
        });
        expect(spawner.calls[0]).toEqual([
          "code-graph",
          "find",
          "execute",
          "/project",
          "--kind",
          "function",
        ]);
      } finally {
        spawner.restore();
      }
    });

    test("passes file scope", async () => {
      const pi = createMockPi();
      registerCodeGraphTools(pi as any);
      const tool = pi.tools.get("find_symbol")!;

      const spawner = mockSpawn("result");
      try {
        await tool.execute("tc-1", { symbol: "Foo", path: "src/bar" }, undefined, undefined, {
          cwd: "/project",
        });
        expect(spawner.calls[0]).toContain("--file");
        expect(spawner.calls[0]).toContain("src/bar");
      } finally {
        spawner.restore();
      }
    });

    test("returns '(no results)' on empty output", async () => {
      const pi = createMockPi();
      registerCodeGraphTools(pi as any);
      const tool = pi.tools.get("find_symbol")!;

      const spawner = mockSpawn("");
      try {
        const result = await tool.execute("tc-1", { symbol: "nonexistent" }, undefined, undefined, {
          cwd: "/project",
        });
        expect(result.content[0].text).toBe("(no results)");
      } finally {
        spawner.restore();
      }
    });

    test("throws on non-zero exit", async () => {
      const pi = createMockPi();
      registerCodeGraphTools(pi as any);
      const tool = pi.tools.get("find_symbol")!;

      const spawner = mockSpawn("", 1, "index error");
      try {
        let threw = false;
        try {
          await tool.execute("tc-1", { symbol: "x" }, undefined, undefined, { cwd: "/project" });
        } catch (err: unknown) {
          threw = true;
          expect((err as Error).message).toContain("code-graph failed");
        }
        expect(threw).toBe(true);
      } finally {
        spawner.restore();
      }
    });
  });

  describe("get_context", () => {
    test("builds correct CLI args", async () => {
      const pi = createMockPi();
      registerCodeGraphTools(pi as any);
      const tool = pi.tools.get("get_context")!;

      const spawner = mockSpawn("definition: ...\nreferences: ...");
      try {
        await tool.execute("tc-1", { symbol: "Blueprint" }, undefined, undefined, {
          cwd: "/project",
        });
        expect(spawner.calls[0]).toEqual(["code-graph", "context", "Blueprint", "/project"]);
      } finally {
        spawner.restore();
      }
    });
  });

  describe("find_references", () => {
    test("builds correct CLI args", async () => {
      const pi = createMockPi();
      registerCodeGraphTools(pi as any);
      const tool = pi.tools.get("find_references")!;

      const spawner = mockSpawn("engine.ts:37 (call)");
      try {
        await tool.execute("tc-1", { symbol: "execute" }, undefined, undefined, {
          cwd: "/project",
        });
        expect(spawner.calls[0]).toEqual(["code-graph", "refs", "execute", "/project"]);
      } finally {
        spawner.restore();
      }
    });

    test("passes kind and path filters", async () => {
      const pi = createMockPi();
      registerCodeGraphTools(pi as any);
      const tool = pi.tools.get("find_references")!;

      const spawner = mockSpawn("result");
      try {
        await tool.execute(
          "tc-1",
          { symbol: "Foo", kind: "class", path: "src/" },
          undefined,
          undefined,
          { cwd: "/project" },
        );
        expect(spawner.calls[0]).toContain("--kind");
        expect(spawner.calls[0]).toContain("class");
        expect(spawner.calls[0]).toContain("--file");
        expect(spawner.calls[0]).toContain("src/");
      } finally {
        spawner.restore();
      }
    });

    test("returns empty-state message on no refs", async () => {
      const pi = createMockPi();
      registerCodeGraphTools(pi as any);
      const tool = pi.tools.get("find_references")!;

      const spawner = mockSpawn("");
      try {
        const result = await tool.execute("tc-1", { symbol: "unused" }, undefined, undefined, {
          cwd: "/project",
        });
        expect(result.content[0].text).toBe("(no references found)");
      } finally {
        spawner.restore();
      }
    });
  });

  describe("get_impact", () => {
    test("builds correct CLI args", async () => {
      const pi = createMockPi();
      registerCodeGraphTools(pi as any);
      const tool = pi.tools.get("get_impact")!;

      const spawner = mockSpawn("3 files affected\nengine.ts\nschema.ts\nindex.ts");
      try {
        await tool.execute("tc-1", { symbol: "Blueprint" }, undefined, undefined, {
          cwd: "/project",
        });
        expect(spawner.calls[0]).toEqual(["code-graph", "impact", "Blueprint", "/project"]);
      } finally {
        spawner.restore();
      }
    });

    test("returns empty-state message on no dependents", async () => {
      const pi = createMockPi();
      registerCodeGraphTools(pi as any);
      const tool = pi.tools.get("get_impact")!;

      const spawner = mockSpawn("");
      try {
        const result = await tool.execute("tc-1", { symbol: "isolated" }, undefined, undefined, {
          cwd: "/project",
        });
        expect(result.content[0].text).toBe("(no dependents found)");
      } finally {
        spawner.restore();
      }
    });
  });

  describe("custom binary", () => {
    test("uses custom binary path in all tools", async () => {
      const pi = createMockPi();
      registerCodeGraphTools(pi as any, { binary: "/opt/cg" });

      const spawner = mockSpawn("result");
      try {
        for (const [name, tool] of pi.tools) {
          const params: Record<string, string> =
            name === "find_symbol" || name === "find_references"
              ? { symbol: "x" }
              : name === "get_context" || name === "get_impact"
                ? { symbol: "x" }
                : { symbol: "x" };
          await tool.execute("tc", params, undefined, undefined, {
            cwd: "/p",
          });
        }
        // All 4 calls should use the custom binary
        expect(spawner.calls).toHaveLength(4);
        for (const call of spawner.calls) {
          expect(call[0]).toBe("/opt/cg");
        }
      } finally {
        spawner.restore();
      }
    });
  });
});
