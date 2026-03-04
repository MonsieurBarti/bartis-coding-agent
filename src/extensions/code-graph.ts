/**
 * Pi extension: code-graph tools
 *
 * Registers a curated subset of code-graph CLI commands as native Pi tools:
 * - find_symbol: Find symbol definitions by name or regex
 * - get_context: 360° view of a symbol (definition, references, callers, callees)
 * - find_references: Find all files and call sites that reference a symbol
 * - get_impact: Get the blast radius of changing a symbol
 *
 * Each tool shells out to the `code-graph` CLI binary with compact output format.
 */

import { Type } from "@sinclair/typebox";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

/** Options for configuring the code-graph extension. */
export interface CodeGraphExtensionOptions {
  /** Path to the code-graph binary. Defaults to "code-graph". */
  binary?: string;
}

/**
 * Run a code-graph CLI command and return its stdout.
 * Throws on non-zero exit with stderr included.
 */
async function runCodeGraph(
  binary: string,
  args: string[],
): Promise<string> {
  const proc = Bun.spawn([binary, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const exitCode = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(
      `code-graph failed (exit ${exitCode})${stderr.trim() ? `: ${stderr.trim()}` : ""}`,
    );
  }
  return stdout.trim();
}

/**
 * Register code-graph tools on a Pi ExtensionAPI instance.
 * Exported for direct use in tests or SDK-based sessions.
 */
export function registerCodeGraphTools(
  pi: ExtensionAPI,
  options: CodeGraphExtensionOptions = {},
): void {
  const binary = options.binary ?? "code-graph";

  // --- find_symbol ---
  pi.registerTool({
    name: "find_symbol",
    label: "Find Symbol",
    description:
      "Find symbol definitions by name or regex pattern. Returns file:line locations and symbol kind.",
    promptSnippet:
      "Find symbol definitions by name or regex (file:line locations).",
    promptGuidelines: [
      "Use find_symbol to locate where a function, class, type, or variable is defined.",
      "Supports regex patterns (e.g. 'User.*Service').",
      "Use the kind filter to narrow results (function, class, interface, type, enum, variable).",
    ],
    parameters: Type.Object({
      symbol: Type.String({ description: "Symbol name or regex pattern" }),
      kind: Type.Optional(
        Type.String({
          description:
            "Filter by symbol kind (comma-separated): function, class, interface, type, enum, variable, component, method, property",
        }),
      ),
      path: Type.Optional(
        Type.String({
          description:
            "Scope search to a file or directory (relative to project root)",
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const args = ["find", params.symbol, ctx.cwd];
      if (params.kind) args.push("--kind", params.kind);
      if (params.path) args.push("--file", params.path);
      const output = await runCodeGraph(binary, args);
      return {
        content: [{ type: "text", text: output || "(no results)" }],
        details: {},
      };
    },
  });

  // --- get_context ---
  pi.registerTool({
    name: "get_context",
    label: "Symbol Context",
    description:
      "360-degree view of a symbol: definition, references, callers, callees, and type hierarchy.",
    promptSnippet:
      "Full context for a symbol: definition, references, callers, callees.",
    promptGuidelines: [
      "Use get_context for a comprehensive view of how a symbol is used across the codebase.",
      "Combines find + refs + call graph in a single query — prefer this over multiple separate calls.",
    ],
    parameters: Type.Object({
      symbol: Type.String({ description: "Symbol name or regex pattern" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const args = ["context", params.symbol, ctx.cwd];
      const output = await runCodeGraph(binary, args);
      return {
        content: [{ type: "text", text: output || "(no results)" }],
        details: {},
      };
    },
  });

  // --- find_references ---
  pi.registerTool({
    name: "find_references",
    label: "Find References",
    description:
      "Find all files and call sites that reference a symbol. Shows import and call edges.",
    promptSnippet:
      "Find all references to a symbol across the codebase.",
    promptGuidelines: [
      "Use find_references to see where a symbol is imported and called.",
      "Helpful for understanding usage patterns before refactoring.",
    ],
    parameters: Type.Object({
      symbol: Type.String({ description: "Symbol name or regex pattern" }),
      kind: Type.Optional(
        Type.String({
          description: "Filter by symbol kind (comma-separated)",
        }),
      ),
      path: Type.Optional(
        Type.String({
          description:
            "Scope search to a file or directory (relative to project root)",
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const args = ["refs", params.symbol, ctx.cwd];
      if (params.kind) args.push("--kind", params.kind);
      if (params.path) args.push("--file", params.path);
      const output = await runCodeGraph(binary, args);
      return {
        content: [{ type: "text", text: output || "(no references found)" }],
        details: {},
      };
    },
  });

  // --- get_impact ---
  pi.registerTool({
    name: "get_impact",
    label: "Impact Analysis",
    description:
      "Get the blast radius of changing a symbol. Returns transitive dependent files.",
    promptSnippet:
      "Show the blast radius of changing a symbol (transitive dependents).",
    promptGuidelines: [
      "Use get_impact before making changes to understand what could break.",
      "Returns files that transitively depend on the symbol's defining file.",
    ],
    parameters: Type.Object({
      symbol: Type.String({ description: "Symbol name or regex pattern" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const args = ["impact", params.symbol, ctx.cwd];
      const output = await runCodeGraph(binary, args);
      return {
        content: [{ type: "text", text: output || "(no dependents found)" }],
        details: {},
      };
    },
  });
}

/**
 * Pi extension entry point.
 * Auto-discovered when placed in ~/.pi/agent/extensions/ or .pi/extensions/.
 */
export default function codeGraphExtension(pi: ExtensionAPI): void {
  registerCodeGraphTools(pi);
}
