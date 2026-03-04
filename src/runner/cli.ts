#!/usr/bin/env bun
/**
 * CLI entry point for the Pi SDK runner.
 *
 * Usage:
 *   bun src/runner/cli.ts --task "Fix the login bug" --project /path/to/project [--blueprint /path/to/blueprint.yaml]
 */
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { runPiAgent } from "./runner";

const { values } = parseArgs({
  options: {
    task: { type: "string", short: "t" },
    project: { type: "string", short: "p" },
    blueprint: { type: "string", short: "b" },
    cwd: { type: "string" },
  },
  strict: true,
});

if (!values.task || !values.project) {
  console.error("Usage: bun src/runner/cli.ts --task <task> --project <path> [--blueprint <path>]");
  process.exit(2);
}

const result = await runPiAgent({
  task: values.task,
  projectRoot: resolve(values.project),
  blueprintPath: values.blueprint ? resolve(values.blueprint) : undefined,
  cwd: values.cwd ? resolve(values.cwd) : undefined,
});

process.exit(result.exitCode);
