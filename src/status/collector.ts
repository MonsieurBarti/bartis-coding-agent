/**
 * Status collector — shells out to bd and gt to gather pipeline state.
 */

import type {
  BeadStatus,
  ConvoyStatus,
  ConvoyMember,
  PipelineStage,
  TestResults,
} from "./types";

interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

async function run(command: string): Promise<CommandResult> {
  const proc = Bun.spawn(["sh", "-c", command], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

/**
 * Fetch bead status from `bd show <id> --json`.
 */
export async function fetchBeadStatus(beadId: string): Promise<BeadStatus> {
  const { exitCode, stdout } = await run(`bd show ${beadId} --json`);
  if (exitCode !== 0) {
    throw new Error(`bd show ${beadId} failed (exit ${exitCode})`);
  }

  const parsed = JSON.parse(stdout);
  const bead = Array.isArray(parsed) ? parsed[0] : parsed;

  return {
    id: bead.id,
    title: bead.title,
    status: bead.status,
    priority: bead.priority ?? 2,
    issueType: bead.issue_type ?? "task",
    assignee: bead.assignee,
    owner: bead.owner,
    createdAt: bead.created_at,
    updatedAt: bead.updated_at,
  };
}

/**
 * Fetch convoy status from `gt convoy status --json`.
 * Returns null if no active convoy.
 */
export async function fetchConvoyStatus(): Promise<ConvoyStatus | null> {
  const { exitCode, stdout } = await run("gt convoy status --json");
  if (exitCode !== 0) return null;

  const trimmed = stdout.trim();
  if (!trimmed || trimmed.includes("No active convoys")) return null;

  try {
    const parsed = JSON.parse(trimmed);
    const convoy = Array.isArray(parsed) ? parsed[0] : parsed;
    if (!convoy?.name) return null;

    const members: ConvoyMember[] = (convoy.members ?? []).map(
      (m: Record<string, unknown>) => ({
        id: String(m.id ?? ""),
        title: String(m.title ?? ""),
        status: String(m.status ?? "unknown"),
        assignee: m.assignee ? String(m.assignee) : undefined,
      }),
    );

    return {
      name: convoy.name,
      status: convoy.status ?? "active",
      members,
      createdAt: convoy.created_at,
    };
  } catch {
    return null;
  }
}

/**
 * Derive the pipeline stage from bead status string.
 */
export function deriveStage(beadStatus: string): PipelineStage {
  const s = beadStatus.toLowerCase();
  if (s === "open" || s === "queued") return "queued";
  if (s === "hooked" || s === "in_progress" || s === "claimed") return "implementing";
  if (s === "testing") return "testing";
  if (s === "reviewing" || s === "in_review") return "reviewing";
  if (s === "merging" || s === "merged") return "merging";
  if (s === "closed" || s === "done" || s === "complete") return "complete";
  if (s === "failed" || s === "error") return "failed";
  return "unknown";
}

/**
 * Run the project test command and collect results.
 * Returns null if no test command is provided.
 */
export async function collectTestResults(
  testCommand?: string,
): Promise<TestResults | null> {
  if (!testCommand) return null;

  const { exitCode, stdout, stderr } = await run(testCommand);
  const output = [stdout, stderr].map((s) => s.trim()).filter(Boolean).join("\n");

  // Try to parse Bun test output (e.g., "3 pass, 1 fail, 4 total")
  const counts = parseTestCounts(output);

  return {
    passed: exitCode === 0,
    summary: truncate(output, 200),
    ...counts,
  };
}

/** Extract test counts from common test runner output formats. */
function parseTestCounts(
  output: string,
): { total?: number; pass?: number; fail?: number } {
  // Bun test: "3 pass\n0 fail\n3 expect() calls"
  const passMatch = output.match(/(\d+)\s+pass/i);
  const failMatch = output.match(/(\d+)\s+fail/i);
  if (passMatch || failMatch) {
    const pass = passMatch ? parseInt(passMatch[1], 10) : 0;
    const fail = failMatch ? parseInt(failMatch[1], 10) : 0;
    return { pass, fail, total: pass + fail };
  }
  return {};
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + "..." : s;
}
