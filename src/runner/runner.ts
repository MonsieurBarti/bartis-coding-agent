import { readFile } from "node:fs/promises";
import {
  createAgentSession,
  SessionManager,
  runPrintMode,
  type CreateAgentSessionOptions,
  type CreateAgentSessionResult,
} from "@mariozechner/pi-coding-agent";
import { loadProfile, type PipelineProfile } from "../profile";

export interface RunPiAgentOptions {
  /** Human-readable task description for the agent */
  task: string;
  /** Absolute path to the project root (where .pi/pipeline.yaml lives) */
  projectRoot: string;
  /** Path to a blueprint file (optional — contents are prepended to the prompt) */
  blueprintPath?: string;
  /** Working directory for the agent (defaults to projectRoot) */
  cwd?: string;
}

export interface RunPiAgentResult {
  /** 0 = success, 1 = failure */
  exitCode: number;
}

/**
 * Build the prompt that combines profile context + blueprint + task.
 */
export async function buildPrompt(
  profile: PipelineProfile,
  task: string,
  blueprintPath?: string,
): Promise<string> {
  const parts: string[] = [];

  // Profile context
  parts.push(
    `Project: ${profile.project.language} (${profile.project.packageManager})`,
  );
  if (profile.rules.length > 0) {
    parts.push(`Rules:\n${profile.rules.map((r) => `- ${r}`).join("\n")}`);
  }

  // Blueprint (if provided)
  if (blueprintPath) {
    try {
      const blueprint = await readFile(blueprintPath, "utf-8");
      parts.push(`Blueprint:\n${blueprint}`);
    } catch {
      // Blueprint engine may not exist yet — stub gracefully
      parts.push(`(Blueprint file not found at ${blueprintPath}, skipping)`);
    }
  }

  // Task
  parts.push(`Task:\n${task}`);

  return parts.join("\n\n");
}

/**
 * Run a Pi coding agent session headlessly.
 *
 * Creates an in-memory session, sends the task as a prompt, waits for
 * completion, and returns the exit code.
 */
export async function runPiAgent(
  options: RunPiAgentOptions,
): Promise<RunPiAgentResult> {
  const { task, projectRoot, blueprintPath, cwd = projectRoot } = options;

  // Load project profile
  const profile = await loadProfile(projectRoot);

  // Build the combined prompt
  const prompt = await buildPrompt(profile, task, blueprintPath);

  // Create a headless agent session
  const { session } = await createAgentSession({
    sessionManager: SessionManager.inMemory(cwd),
    cwd,
  });

  try {
    // Run in print mode (single-shot: send prompt, wait for completion)
    await runPrintMode(session, {
      mode: "text",
      initialMessage: prompt,
    });

    return { exitCode: 0 };
  } catch (error) {
    console.error(
      "Pi agent failed:",
      error instanceof Error ? error.message : error,
    );
    return { exitCode: 1 };
  } finally {
    session.dispose();
  }
}
