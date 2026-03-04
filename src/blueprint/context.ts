import { z } from "zod";

/**
 * Supported code-graph query types for context assembly.
 * Each maps to a code-graph MCP tool that returns deterministic results.
 */
export const ContextQueryKind = z.enum([
  "stats",
  "structure",
  "file_summary",
  "imports",
  "symbol",
  "references",
]);
export type ContextQueryKind = z.infer<typeof ContextQueryKind>;

/**
 * A single code-graph query to run during context assembly.
 */
export const ContextQuerySchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("stats"),
  }),
  z.object({
    kind: z.literal("structure"),
    path: z.string().optional(),
    depth: z.number().int().positive().optional(),
  }),
  z.object({
    kind: z.literal("file_summary"),
    path: z.string(),
  }),
  z.object({
    kind: z.literal("imports"),
    path: z.string(),
  }),
  z.object({
    kind: z.literal("symbol"),
    symbol: z.string(),
    kind_filter: z.string().optional(),
  }),
  z.object({
    kind: z.literal("references"),
    symbol: z.string(),
  }),
]);
export type ContextQuery = z.infer<typeof ContextQuerySchema>;

/**
 * Context assembly configuration for an agent node.
 */
export const ContextConfigSchema = z.object({
  queries: z.array(ContextQuerySchema).min(1),
});
export type ContextConfig = z.infer<typeof ContextConfigSchema>;

/** Result of a single context query. */
export interface QueryResult {
  query: ContextQuery;
  output: string;
  error?: string;
}

/** Full assembled context ready for injection. */
export interface AssembledContext {
  results: QueryResult[];
  text: string;
}

/**
 * Interface for executing code-graph queries.
 * Implementations can use MCP client, CLI subprocess, or mock.
 */
export interface CodeGraphExecutor {
  execute(query: ContextQuery, projectPath: string): Promise<string>;
}

/**
 * Default executor that invokes code-graph via subprocess JSON-RPC.
 * Shells out to `code-graph` CLI with --json flag for each query.
 */
export class SubprocessExecutor implements CodeGraphExecutor {
  constructor(private binary: string = "code-graph") {}

  async execute(query: ContextQuery, projectPath: string): Promise<string> {
    const args = this.buildArgs(query, projectPath);
    const proc = Bun.spawn(args, {
      stdout: "pipe",
      stderr: "pipe",
    });
    const exitCode = await proc.exited;
    const stdout = await new Response(proc.stdout).text();
    if (exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text();
      throw new Error(
        `code-graph query failed (exit ${exitCode}): ${query.kind}${stderr.trim() ? `\n${stderr.trim()}` : ""}`,
      );
    }
    return stdout.trim();
  }

  private buildArgs(query: ContextQuery, projectPath: string): string[] {
    const base = [this.binary, "--project-path", projectPath];
    switch (query.kind) {
      case "stats":
        return [...base, "stats"];
      case "structure":
        return [
          ...base,
          "structure",
          ...(query.path ? ["--path", query.path] : []),
          ...(query.depth ? ["--depth", String(query.depth)] : []),
        ];
      case "file_summary":
        return [...base, "file-summary", "--path", query.path];
      case "imports":
        return [...base, "imports", "--path", query.path];
      case "symbol":
        return [
          ...base,
          "find-symbol",
          "--symbol",
          query.symbol,
          ...(query.kind_filter ? ["--kind", query.kind_filter] : []),
        ];
      case "references":
        return [...base, "find-references", "--symbol", query.symbol];
    }
  }
}

/**
 * Assemble context by running all configured code-graph queries.
 * Queries run sequentially; failures are captured but don't abort assembly.
 */
export async function assembleContext(
  config: ContextConfig,
  projectPath: string,
  executor: CodeGraphExecutor,
): Promise<AssembledContext> {
  const results: QueryResult[] = [];

  for (const query of config.queries) {
    try {
      const output = await executor.execute(query, projectPath);
      results.push({ query, output });
    } catch (err: unknown) {
      const error = err instanceof Error ? err.message : String(err);
      results.push({ query, output: "", error });
    }
  }

  const text = formatContext(results);
  return { results, text };
}

/**
 * Format query results into a text block for prompt injection.
 */
function formatContext(results: QueryResult[]): string {
  const sections: string[] = [];

  for (const result of results) {
    const label = queryLabel(result.query);
    if (result.error) {
      sections.push(`## ${label}\n(query failed: ${result.error})`);
    } else if (result.output) {
      sections.push(`## ${label}\n${result.output}`);
    }
  }

  if (sections.length === 0) return "";
  return `# Codebase Context\n\n${sections.join("\n\n")}`;
}

/** Human-readable label for a query result section. */
function queryLabel(query: ContextQuery): string {
  switch (query.kind) {
    case "stats":
      return "Project Stats";
    case "structure":
      return query.path ? `Structure: ${query.path}` : "Project Structure";
    case "file_summary":
      return `File: ${query.path}`;
    case "imports":
      return `Imports: ${query.path}`;
    case "symbol":
      return `Symbol: ${query.symbol}`;
    case "references":
      return `References: ${query.symbol}`;
  }
}
