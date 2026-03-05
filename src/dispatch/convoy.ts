/**
 * Convoy-based dispatch — tracks each Discord request through Gas Town.
 *
 * Flow:
 *   1. bd create issue for the task
 *   2. gt sling to dispatch a polecat (auto-creates convoy)
 *   3. Poll bd show for issue status until closed/failed
 *   4. Find PR URL from GitHub branch or bd show
 *
 * Note: gt sling auto-creates a convoy named "Work: [issue-title]"
 * so we don't need to manually create convoys for single-issue dispatch.
 * Explicit convoy creation (createConvoy) is kept for future batch dispatch.
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
  issueId: string;
  status: string;
  elapsed: number;
}

export interface ConvoyDispatchResult {
  success: boolean;
  issueId: string;
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
 * @param description - Optional detailed description.
 */
export async function createIssue(
  title: string,
  issueType: string = "task",
  description?: string,
): Promise<string> {
  const args = ["create", "--json", "-t", issueType];
  if (description) args.push(`--description=${description}`);
  args.push(title);
  const stdout = await run("bd", args);
  const parsed = JSON.parse(stdout);
  const id = Array.isArray(parsed) ? parsed[0]?.id : parsed?.id;
  if (!id) throw new Error(`Failed to parse issue ID from bd output: ${stdout}`);
  return id;
}

/**
 * Sling work onto a polecat in the target rig.
 * gt sling auto-creates a convoy to track the issue.
 *
 * Uses --merge=mr so the polecat pushes the branch to origin
 * and the refinery opens a PR for review.
 */
export async function slingWork(issueId: string, rig: string, args?: string): Promise<void> {
  const cmdArgs = ["sling", issueId, rig, "--merge=mr"];
  if (args) {
    cmdArgs.push("--args", args);
  }
  await run("gt", cmdArgs);
}

/**
 * Auto-close any convoys whose tracked issues are all complete.
 * gt sling already adds the issue to the convoy it creates,
 * so we just need to trigger the check after completion.
 */
export async function closeCompletedConvoys(): Promise<void> {
  await tryRun("gt", ["convoy", "check"]);
}

/**
 * Get the current status of an issue from bd show.
 */
export async function getIssueStatus(
  issueId: string,
): Promise<{ status: string; assignee?: string } | null> {
  const stdout = await tryRun("bd", ["show", issueId, "--json"]);
  if (!stdout) return null;

  try {
    const parsed = JSON.parse(stdout);
    const bead = Array.isArray(parsed) ? parsed[0] : parsed;
    return {
      status: bead?.status ?? "unknown",
      assignee: bead?.assignee,
    };
  } catch {
    return null;
  }
}

/**
 * Check if an issue status indicates completion.
 */
function isComplete(status: string): boolean {
  const s = status.toLowerCase();
  return s === "closed" || s === "done" || s === "complete" || s === "merged";
}

/**
 * Check if an issue status indicates failure.
 */
function isFailed(status: string): boolean {
  const s = status.toLowerCase();
  return s === "failed" || s === "error" || s === "cancelled";
}

/**
 * Try to find a PR URL associated with the issue.
 *
 * Strategy:
 *   1. Check bd show output for a GitHub PR URL
 *   2. Search GitHub for a PR from the polecat branch pattern
 */
export async function findPrUrl(issueId: string): Promise<string | null> {
  // 1. Check bd show for embedded PR URL
  const bdOut = await tryRun("bd", ["show", issueId, "--json"]);
  if (bdOut) {
    const match = bdOut.match(/https:\/\/github\.com\/[^\s"]+\/pull\/\d+/);
    if (match) return match[0];
  }

  // 2. Search for PR from polecat branch pattern (polecat/*/<issueId>@*)
  const ghOut = await tryRun("gh", [
    "pr",
    "list",
    "--state",
    "all",
    "--search",
    issueId,
    "--json",
    "url,headRefName",
    "--limit",
    "5",
  ]);
  if (ghOut) {
    try {
      const prs = JSON.parse(ghOut);
      const match = prs.find((pr: { headRefName?: string }) => pr.headRefName?.includes(issueId));
      if (match?.url) return match.url;
    } catch {
      // ignore parse errors
    }
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
 * Dispatch a task through the sling pipeline.
 *
 * Creates an issue, slings it to a polecat (which auto-creates a convoy),
 * and polls the issue status until closed/failed or timeout.
 */
export async function dispatchConvoy(
  options: ConvoyDispatchOptions,
): Promise<ConvoyDispatchResult> {
  const { task, rig, args, pollIntervalMs = 10_000, timeoutMs = 600_000, onPoll } = options;

  // 1. Create issue
  const issueId = await createIssue(`Discord: ${task} (rig: ${rig})`);

  // 2. Sling work to polecat (auto-creates convoy)
  try {
    await slingWork(issueId, rig, args);
  } catch (err) {
    return {
      success: false,
      issueId,
      summary: "Failed to sling work",
      error: err instanceof Error ? err.message : String(err),
    };
  }

  // 3. Poll issue status
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    await sleep(pollIntervalMs);

    const elapsed = Date.now() - startTime;
    const issue = await getIssueStatus(issueId);

    if (issue) {
      onPoll?.({ issueId, status: issue.status, elapsed });

      if (isComplete(issue.status)) {
        await closeCompletedConvoys();
        const prUrl = (await findPrUrl(issueId)) ?? undefined;
        return {
          success: true,
          issueId,
          prUrl,
          summary: `Issue ${issueId} completed`,
        };
      }

      if (isFailed(issue.status)) {
        await closeCompletedConvoys();
        return {
          success: false,
          issueId,
          summary: `Issue ${issueId} failed`,
          error: `Status: ${issue.status}`,
        };
      }
    }
  }

  // Timeout — check one last time for PR
  const prUrl = (await findPrUrl(issueId)) ?? undefined;
  return {
    success: false,
    issueId,
    prUrl,
    summary: `Issue ${issueId} timed out after ${Math.round(timeoutMs / 1000)}s`,
    error: "Timeout waiting for issue to close",
  };
}
