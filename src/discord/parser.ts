export interface ParsedRequest {
  /** The task description extracted from the message. */
  task: string;
  /** Absolute path to the target repository. */
  repo: string;
}

/**
 * Parse a Discord message for a task description and target repo.
 *
 * Expected format (after bot mention is stripped):
 *   <repo> <task description>
 *
 * The repo can be:
 *   - An absolute path: /Users/foo/project
 *   - A relative name: my-project (resolved against common roots)
 *
 * Everything after the repo token is the task description.
 */
export function parseMessage(content: string, botUserId: string): ParsedRequest | null {
  // Strip the bot mention(s)
  const mentionPattern = new RegExp(`<@!?${botUserId}>`, "g");
  const stripped = content.replace(mentionPattern, "").trim();

  if (!stripped) return null;

  // Split into tokens: first token is repo, rest is task
  const firstSpace = stripped.indexOf(" ");
  if (firstSpace === -1) return null; // Need both repo and task

  const repo = stripped.slice(0, firstSpace).trim();
  const task = stripped.slice(firstSpace + 1).trim();

  if (!repo || !task) return null;

  return { task, repo };
}
