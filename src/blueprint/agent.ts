import {
  codingTools,
  createAgentSession,
  runPrintMode,
  SessionManager,
} from "@mariozechner/pi-coding-agent";

/**
 * Interface for running an agent with a prompt.
 * Implement this to swap in different agent backends or mocks for testing.
 */
export interface AgentRunner {
  /** Run the agent with the given prompt. Throws on failure. */
  run(prompt: string, options?: { cwd?: string }): Promise<void>;
}

/**
 * Default agent runner backed by the Pi coding agent SDK.
 *
 * Creates an in-memory session, sends the prompt in print mode,
 * and throws if the agent fails.
 */
export class PiAgentRunner implements AgentRunner {
  async run(prompt: string, options?: { cwd?: string }): Promise<void> {
    const cwd = options?.cwd ?? process.cwd();

    const { session } = await createAgentSession({
      sessionManager: SessionManager.inMemory(cwd),
      cwd,
      tools: codingTools,
    });

    try {
      await runPrintMode(session, {
        mode: "text",
        initialMessage: prompt,
      });
    } finally {
      session.dispose();
    }
  }
}
