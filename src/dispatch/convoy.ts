/**
 * Convoy-based dispatch — tracks each Discord request as a convoy.
 *
 * Flow:
 *   1. bd create issue for the task
 *   2. gt convoy create to track it
 *   3. gt sling to dispatch a polecat
 *   4. Poll gt convoy status until landed/failed
 *   5. Return PR link and summary
 */

export interface ConvoyDispatchOptions {
  /** Human-readable task description. */
  task: string;
  /** Target rig to sling work to. */
  rig: string;
  /** Natural-language args for the slung polecat. */
  args?: string;
  /** Poll interval in ms (default: 10_000). */
  pollIntervalMs?: number;
  /** Max wait time in ms before giving up (default: 600_000 = 10 min). */
  timeoutMs?: number;
  /** Callback invoked on each poll with current status. */
  onPoll?: (status: ConvoyPollStatus) => void;
}

export interface ConvoyPollStatus {
  convoyId: string;
  status: string;
  elapsed: number;
}

export interface ConvoyDispatchResult {
  success: boolean;
  issueId: string;
  convoyId: string;
  prUrl?: string;
  summary: string;
  error?: string;
}

/**
 * Run a command with args via Bun.spawn. Returns stdout on success.
 * Throws on non-zero exit.
 */
async function run(cmd: string, args: string[]): Promise<string> {
  const proc = Bun.spawn([cmd, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  await proc.exited;

  if (proc.exitCode !== 0) {
    throw new Error(`${cmd} ${args[0]} failed (exit ${proc.exitCode}): ${stderr}`);
  }
  return stdout.trim();
}

/**
 * Run a command, returning stdout or null on failure.
 */
async function tryRun(cmd: string, args: string[]): Promise<string | null> {
  try {
    return await run(cmd, args);
  } catch {
    return null;
  }
}

/**
 * Create a bd issue for the task. Returns the issue ID.
 *
 * @param title - Issue title
 * @param issueType - bd issue type (task, bug, feature, etc.). Defaults to "task".
 */
export async function createIssue(title: string, issueType: string = "task"): Promise<string> {
  const stdout = await run("bd", ["create", "--json", "-t", issueType, title]);
  const parsed = JSON.parse(stdout);
  const id = Array.isArray(parsed) ? parsed[0]?.id : parsed?.id;
  if (!id) throw new Error(`Failed to parse issue ID from bd output: ${stdout}`);
  return id;
}

/**
 * Create a convoy tracking the given issue. Returns the convoy ID.
 */
export async function createConvoy(issueId: string, taskSummary: string): Promise<string> {
  const name = `Discord: ${taskSummary.slice(0, 60)}`;
  const stdout = await run("gt", ["convoy", "create", name, issueId]);

  // Try to parse convoy ID from JSON output
  try {
    const parsed = JSON.parse(stdout);
    const id = parsed?.id ?? parsed?.convoy_id;
    if (id) return id;
  } catch {
    // Fall back to regex extraction
  }

  // Look for hq-* pattern in output
  const match = stdout.match(/\b(hq-[a-zA-Z0-9._-]+)\b/);
  if (match) return match[1];

  throw new Error(`Failed to parse convoy ID from output: ${stdout}`);
}

/**
 * Sling work onto a polecat in the target rig.
 */
export async function slingWork(issueId: string, rig: string, args?: string): Promise<void> {
  const cmdArgs = ["sling", issueId, rig];
  if (args) {
    cmdArgs.push("--args", args);
  }
  await run("gt", cmdArgs);
}

/**
 * Poll convoy status. Returns parsed status object.
 */
export async function getConvoyStatus(
  convoyId: string,
): Promise<{ status: string; members: Array<{ id: string; status: string }> } | null> {
  const stdout = await tryRun("gt", ["convoy", "status", convoyId, "--json"]);
  if (!stdout) return null;

  try {
    const parsed = JSON.parse(stdout);
    const convoy = Array.isArray(parsed) ? parsed[0] : parsed;
    return {
      status: convoy?.status ?? "unknown",
      members: (convoy?.members ?? []).map((m: Record<string, unknown>) => ({
        id: String(m.id ?? ""),
        status: String(m.status ?? "unknown"),
      })),
    };
  } catch {
    return null;
  }
}

/**
 * Check if a convoy has landed (all tracked issues closed).
 */
function isLanded(status: string): boolean {
  const s = status.toLowerCase();
  return s === "landed" || s === "closed" || s === "complete" || s === "done";
}

/**
 * Check if a convoy has failed.
 */
function isFailed(status: string): boolean {
  const s = status.toLowerCase();
  return s === "failed" || s === "error" || s === "cancelled";
}

/**
 * Try to find a PR URL associated with the issue.
 */
export async function findPrUrl(issueId: string): Promise<string | null> {
  const bdOut = await tryRun("bd", ["show", issueId, "--json"]);
  if (bdOut) {
    const match = bdOut.match(/https:\/\/github\.com\/[^\s"]+\/pull\/\d+/);
    if (match) return match[0];
  }
  return null;
}

/**
 * Sleep for the given number of milliseconds.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Dispatch a task through the convoy pipeline.
 *
 * Creates an issue, wraps it in a convoy, slings to a polecat,
 * and polls until the convoy lands or times out.
 */
export async function dispatchConvoy(
  options: ConvoyDispatchOptions,
): Promise<ConvoyDispatchResult> {
  const {
    task,
    rig,
    args,
    pollIntervalMs = 10_000,
    timeoutMs = 600_000,
    onPoll,
  } = options;

  // 1. Create issue
  const issueId = await createIssue(`Discord: ${task} (rig: ${rig})`);

  // 2. Create convoy
  let convoyId: string;
  try {
    convoyId = await createConvoy(issueId, task);
  } catch (err) {
    return {
      success: false,
      issueId,
      convoyId: "",
      summary: "Failed to create convoy",
      error: err instanceof Error ? err.message : String(err),
    };
  }

  // 3. Sling work to polecat
  try {
    await slingWork(issueId, rig, args);
  } catch (err) {
    return {
      success: false,
      issueId,
      convoyId,
      summary: "Failed to sling work",
      error: err instanceof Error ? err.message : String(err),
    };
  }

  // 4. Poll convoy status
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    await sleep(pollIntervalMs);

    const elapsed = Date.now() - startTime;
    const status = await getConvoyStatus(convoyId);

    if (status) {
      onPoll?.({ convoyId, status: status.status, elapsed });

      if (isLanded(status.status)) {
        const prUrl = (await findPrUrl(issueId)) ?? undefined;
        return {
          success: true,
          issueId,
          convoyId,
          prUrl,
          summary: `Convoy ${convoyId} landed successfully`,
        };
      }

      if (isFailed(status.status)) {
        return {
          success: false,
          issueId,
          convoyId,
          summary: `Convoy ${convoyId} failed`,
          error: `Status: ${status.status}`,
        };
      }
    }
  }

  // Timeout — check one last time for PR
  const prUrl = (await findPrUrl(issueId)) ?? undefined;
  return {
    success: false,
    issueId,
    convoyId,
    prUrl,
    summary: `Convoy ${convoyId} timed out after ${Math.round(timeoutMs / 1000)}s`,
    error: "Timeout waiting for convoy to land",
  };
}
