import { describe, expect, test } from "bun:test";
import {
  assembleContext,
  type CodeGraphExecutor,
  type ContextConfig,
  ContextConfigSchema,
  type ContextQuery,
  ContextQuerySchema,
} from "../context";

/** Mock executor that returns canned responses. */
class MockExecutor implements CodeGraphExecutor {
  private responses: Map<string, string>;

  constructor(responses: Record<string, string> = {}) {
    this.responses = new Map(Object.entries(responses));
  }

  async execute(query: ContextQuery, _projectPath: string): Promise<string> {
    const key = query.kind;
    const response = this.responses.get(key);
    if (response === undefined) {
      throw new Error(`No mock response for query kind: ${key}`);
    }
    return response;
  }
}

/** Mock executor that fails for specific query kinds. */
class FailingExecutor implements CodeGraphExecutor {
  constructor(private failKinds: Set<string> = new Set(["stats"])) {}

  async execute(query: ContextQuery, _projectPath: string): Promise<string> {
    if (this.failKinds.has(query.kind)) {
      throw new Error(`code-graph query failed: ${query.kind}`);
    }
    return `result for ${query.kind}`;
  }
}

describe("ContextQuerySchema", () => {
  test("parses stats query", () => {
    const q = ContextQuerySchema.parse({ kind: "stats" });
    expect(q.kind).toBe("stats");
  });

  test("parses structure query with optional fields", () => {
    const q = ContextQuerySchema.parse({
      kind: "structure",
      path: "src",
      depth: 2,
    });
    expect(q).toEqual({ kind: "structure", path: "src", depth: 2 });
  });

  test("parses structure query without optional fields", () => {
    const q = ContextQuerySchema.parse({ kind: "structure" });
    expect(q.kind).toBe("structure");
  });

  test("parses file_summary query", () => {
    const q = ContextQuerySchema.parse({
      kind: "file_summary",
      path: "src/index.ts",
    });
    expect(q).toEqual({ kind: "file_summary", path: "src/index.ts" });
  });

  test("parses imports query", () => {
    const q = ContextQuerySchema.parse({
      kind: "imports",
      path: "src/main.ts",
    });
    expect(q).toEqual({ kind: "imports", path: "src/main.ts" });
  });

  test("parses symbol query with kind_filter", () => {
    const q = ContextQuerySchema.parse({
      kind: "symbol",
      symbol: "execute",
      kind_filter: "function",
    });
    expect(q).toEqual({
      kind: "symbol",
      symbol: "execute",
      kind_filter: "function",
    });
  });

  test("parses references query", () => {
    const q = ContextQuerySchema.parse({
      kind: "references",
      symbol: "Blueprint",
    });
    expect(q).toEqual({ kind: "references", symbol: "Blueprint" });
  });

  test("rejects unknown query kind", () => {
    expect(() => ContextQuerySchema.parse({ kind: "unknown" })).toThrow();
  });

  test("rejects file_summary without path", () => {
    expect(() => ContextQuerySchema.parse({ kind: "file_summary" })).toThrow();
  });
});

describe("ContextConfigSchema", () => {
  test("parses valid config", () => {
    const config = ContextConfigSchema.parse({
      queries: [{ kind: "stats" }, { kind: "structure", path: "src" }],
    });
    expect(config.queries).toHaveLength(2);
  });

  test("rejects empty queries array", () => {
    expect(() => ContextConfigSchema.parse({ queries: [] })).toThrow();
  });
});

describe("assembleContext", () => {
  test("assembles results from all queries", async () => {
    const config: ContextConfig = {
      queries: [{ kind: "stats" }, { kind: "structure", path: "src" }],
    };
    const executor = new MockExecutor({
      stats: "Files: 42\nSymbols: 128",
      structure: "src/\n  index.ts\n  utils.ts",
    });

    const result = await assembleContext(config, "/project", executor);
    expect(result.results).toHaveLength(2);
    expect(result.results[0].output).toContain("Files: 42");
    expect(result.results[1].output).toContain("index.ts");
    expect(result.text).toContain("# Codebase Context");
    expect(result.text).toContain("## Project Stats");
    expect(result.text).toContain("## Structure: src");
  });

  test("captures errors without aborting", async () => {
    const config: ContextConfig = {
      queries: [{ kind: "stats" }, { kind: "structure" }],
    };
    const executor = new FailingExecutor(new Set(["stats"]));

    const result = await assembleContext(config, "/project", executor);
    expect(result.results).toHaveLength(2);
    expect(result.results[0].error).toContain("code-graph query failed");
    expect(result.results[0].output).toBe("");
    expect(result.results[1].output).toBe("result for structure");
    expect(result.results[1].error).toBeUndefined();
  });

  test("formats error results in text", async () => {
    const config: ContextConfig = {
      queries: [{ kind: "stats" }],
    };
    const executor = new FailingExecutor();

    const result = await assembleContext(config, "/project", executor);
    expect(result.text).toContain("query failed");
  });

  test("returns empty text when all queries fail with empty output", async () => {
    const config: ContextConfig = {
      queries: [{ kind: "stats" }],
    };
    // FailingExecutor throws, so error is captured and output is ""
    const executor = new FailingExecutor();

    const result = await assembleContext(config, "/project", executor);
    // Error results still get included in text with the error message
    expect(result.text).toContain("# Codebase Context");
  });

  test("labels file_summary sections with path", async () => {
    const config: ContextConfig = {
      queries: [{ kind: "file_summary", path: "src/main.ts" }],
    };
    const executor = new MockExecutor({
      file_summary: "exports: main\nimports: fs",
    });

    const result = await assembleContext(config, "/project", executor);
    expect(result.text).toContain("## File: src/main.ts");
  });

  test("labels symbol sections with symbol name", async () => {
    const config: ContextConfig = {
      queries: [{ kind: "symbol", symbol: "execute" }],
    };
    const executor = new MockExecutor({
      symbol: "execute: function @ engine.ts:37",
    });

    const result = await assembleContext(config, "/project", executor);
    expect(result.text).toContain("## Symbol: execute");
  });
});
