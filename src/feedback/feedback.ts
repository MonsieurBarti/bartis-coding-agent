import type { PipelineProfile } from "../profile";

/** Result of a single feedback check (lint or typecheck). */
export interface CheckResult {
  /** Which check ran */
  name: string;
  /** Whether it passed */
  ok: boolean;
  /** Error output (stderr + stdout on failure) */
  output: string;
  /** Wall-clock milliseconds */
  durationMs: number;
}

/** Aggregated feedback from all checks. */
export interface FeedbackResult {
  /** True if every check passed */
  ok: boolean;
  /** Individual check results (only includes checks that were configured) */
  checks: CheckResult[];
  /** Total wall-clock milliseconds */
  durationMs: number;
}

export interface FeedbackOptions {
  /** Working directory for commands (defaults to process.cwd()) */
  cwd?: string;
  /** Timeout per check in milliseconds (default: 5000) */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 5000;

/**
 * Run a single shell command with timeout, capturing output.
 */
async function runCheck(
  name: string,
  command: string,
  cwd: string,
  timeoutMs: number,
): Promise<CheckResult> {
  const start = performance.now();

  const proc = Bun.spawn(["sh", "-c", command], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });

  // Race between completion and timeout
  const timer = setTimeout(() => proc.kill(), timeoutMs);

  // Must read streams before awaiting exit to avoid GC issues in Bun
  const [stderr, stdout, exitCode] = await Promise.all([
    new Response(proc.stderr).text(),
    new Response(proc.stdout).text(),
    proc.exited,
  ]);

  clearTimeout(timer);

  const durationMs = Math.round(performance.now() - start);

  if (exitCode === 0) {
    return { name, ok: true, output: "", durationMs };
  }

  const output = [stderr.trim(), stdout.trim()].filter(Boolean).join("\n");

  return { name, ok: false, output, durationMs };
}

/**
 * Run lint and typecheck from the project profile.
 *
 * Executes configured checks in parallel. Skips any check whose command
 * is not defined in the profile. Returns structured feedback suitable
 * for feeding back to an agent.
 *
 * Designed to be fast (<5s) with per-check timeout enforcement.
 */
export async function runFeedback(
  profile: PipelineProfile,
  options: FeedbackOptions = {},
): Promise<FeedbackResult> {
  const cwd = options.cwd ?? process.cwd();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const start = performance.now();

  // Collect configured checks
  const checks: { name: string; command: string }[] = [];
  if (profile.commands.lint) {
    checks.push({ name: "lint", command: profile.commands.lint });
  }
  if (profile.commands.typecheck) {
    checks.push({ name: "typecheck", command: profile.commands.typecheck });
  }

  // Nothing configured — fast path
  if (checks.length === 0) {
    return { ok: true, checks: [], durationMs: 0 };
  }

  // Run all checks in parallel
  const results = await Promise.all(
    checks.map((c) => runCheck(c.name, c.command, cwd, timeoutMs)),
  );

  const durationMs = Math.round(performance.now() - start);
  const ok = results.every((r) => r.ok);

  return { ok, checks: results, durationMs };
}

/**
 * Format feedback result as a concise string for agent consumption.
 * Only includes details for failed checks.
 */
export function formatFeedback(result: FeedbackResult): string {
  if (result.ok) {
    return `All checks passed (${result.durationMs}ms)`;
  }

  const lines: string[] = [];
  for (const check of result.checks) {
    if (!check.ok) {
      lines.push(`${check.name} failed (${check.durationMs}ms):`);
      lines.push(check.output);
      lines.push("");
    }
  }

  return lines.join("\n").trimEnd();
}
