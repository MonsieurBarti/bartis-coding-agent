import type { PipelineProfile } from "../profile";

export interface CreatePrContext {
  /** PR title */
  title: string;
  /** Summary of changes for the PR body */
  summary: string;
  /** Test results to include in the PR body (optional) */
  testResults?: string;
  /** Link to the original task/issue (optional) */
  taskLink?: string;
  /** Branch to push (defaults to HEAD) */
  branch?: string;
}

/**
 * Interpolate a PR template with context variables.
 *
 * Supported placeholders:
 *   {{title}}, {{summary}}, {{testResults}}, {{taskLink}}
 *
 * Missing optional values resolve to empty string.
 */
export function renderTemplate(
  template: string,
  ctx: CreatePrContext,
): string {
  const vars: Record<string, string> = {
    title: ctx.title,
    summary: ctx.summary,
    testResults: ctx.testResults ?? "",
    taskLink: ctx.taskLink ?? "",
  };
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => vars[key] ?? "");
}

const DEFAULT_TEMPLATE = `## Summary
{{summary}}

## Test Results
{{testResults}}

## Task
{{taskLink}}`;

/**
 * Build the PR body from profile template (or default) and context.
 */
export function buildPrBody(
  profile: PipelineProfile,
  ctx: CreatePrContext,
): string {
  const template = profile.pr.template ?? DEFAULT_TEMPLATE;
  return renderTemplate(template, ctx).trim();
}

/**
 * Build a shell-safe string by escaping single quotes.
 */
function shellEscape(s: string): string {
  return s.replace(/'/g, "'\\''");
}

/**
 * Build the deterministic shell command for push + PR creation.
 *
 * Returns a single command string that:
 * 1. Pushes the branch to origin
 * 2. Creates a PR via `gh pr create`
 */
export function buildCreatePrCommand(
  profile: PipelineProfile,
  ctx: CreatePrContext,
): string {
  const branch = ctx.branch ?? "HEAD";
  const baseBranch = profile.git.baseBranch;
  const body = buildPrBody(profile, ctx);

  const push = `git push -u origin ${branch}`;
  const pr = [
    "gh pr create",
    `--base '${shellEscape(baseBranch)}'`,
    `--title '${shellEscape(ctx.title)}'`,
    `--body '${shellEscape(body)}'`,
  ].join(" ");

  return `${push} && ${pr}`;
}
