import {
  Client,
  Events,
  GatewayIntentBits,
  type Message,
} from "discord.js";
import { loadConfig, type DiscordConfig } from "./config.ts";
import { parseMessage } from "./parser.ts";
import { dispatch } from "../dispatch/dispatch.ts";

/**
 * Create a bd issue for the task via the bd CLI.
 * Returns the issue ID on success.
 */
async function createIssue(
  task: string,
  repo: string,
): Promise<string> {
  const proc = Bun.spawn(
    ["bd", "create", "--json", "-t", "task", `Discord bot task: ${task} (repo: ${repo})`],
    { stdout: "pipe", stderr: "pipe" },
  );
  const stdout = await new Response(proc.stdout).text();
  await proc.exited;

  if (proc.exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`bd create failed (exit ${proc.exitCode}): ${stderr}`);
  }

  const parsed = JSON.parse(stdout);
  // bd create --json returns { id: "bca-xxx", ... }
  const id = Array.isArray(parsed) ? parsed[0]?.id : parsed?.id;
  if (!id) throw new Error(`Failed to parse issue ID from bd output: ${stdout}`);
  return id;
}

/**
 * Extract a PR URL from `gh pr create` output or git push output.
 */
function extractPrUrl(output: string): string | null {
  const match = output.match(/https:\/\/github\.com\/[^\s]+\/pull\/\d+/);
  return match ? match[0] : null;
}

/**
 * Run the full pipeline for a Discord request:
 * 1. Create bd issue
 * 2. Dispatch pipeline
 * 3. Return result summary
 */
async function handleTask(
  task: string,
  repo: string,
): Promise<{ success: boolean; issueId: string; prUrl?: string; error?: string }> {
  // 1. Create issue
  const issueId = await createIssue(task, repo);

  // 2. Run pipeline
  const result = await dispatch({
    task,
    projectRoot: repo,
  });

  if (!result.success) {
    // Collect error details from failed nodes
    const errors: string[] = [];
    for (const [nodeId, state] of result.engine.states) {
      if (state.status === "failure" && state.error) {
        errors.push(`${nodeId}: ${state.error}`);
      }
    }
    return {
      success: false,
      issueId,
      error: errors.join("\n") || "Pipeline failed with unknown error",
    };
  }

  // 3. Try to extract PR URL from engine output
  // The PR URL comes from the create-pr node if present in the blueprint
  // For now, try running gh pr list to find the most recent PR
  const prProc = Bun.spawn(
    ["gh", "pr", "list", "--repo", repo, "--limit", "1", "--json", "url", "--state", "open"],
    { stdout: "pipe", stderr: "pipe", cwd: repo },
  );
  const prStdout = await new Response(prProc.stdout).text();
  await prProc.exited;

  let prUrl: string | undefined;
  if (prProc.exitCode === 0) {
    try {
      const prs = JSON.parse(prStdout);
      if (Array.isArray(prs) && prs.length > 0) {
        prUrl = prs[0].url;
      }
    } catch {
      // Ignore parse failures
    }
  }

  return { success: true, issueId, prUrl };
}

/**
 * Start the Discord bot.
 *
 * Listens for messages mentioning the bot in configured channels,
 * parses them for task + repo, dispatches the pipeline, and replies
 * with the result.
 */
export async function startBot(config?: DiscordConfig): Promise<Client> {
  const cfg = config ?? loadConfig();

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  });

  const channelSet = new Set(cfg.channelIds);

  client.once(Events.ClientReady, (readyClient) => {
    console.log(`Discord bot ready as ${readyClient.user.tag}`);
  });

  client.on(Events.MessageCreate, async (message: Message) => {
    // Ignore bot messages
    if (message.author.bot) return;

    // Only respond in configured channels
    if (!channelSet.has(message.channelId)) return;

    // Only respond when mentioned
    if (!message.mentions.has(client.user!.id)) return;

    const parsed = parseMessage(message.content, client.user!.id);
    if (!parsed) {
      await message.reply(
        "Usage: `@bot <repo-path> <task description>`\n" +
        "Example: `@bot /path/to/project Fix the login page styling`",
      );
      return;
    }

    // Acknowledge receipt
    await message.reply(`Working on it — task: "${parsed.task}" in \`${parsed.repo}\``);

    try {
      const result = await handleTask(parsed.task, parsed.repo);

      if (result.success) {
        const prLine = result.prUrl
          ? `PR: ${result.prUrl}`
          : "No PR URL found (check the repo for recent PRs)";
        await message.reply(`Done! Issue: \`${result.issueId}\`\n${prLine}`);
      } else {
        await message.reply(
          `Pipeline failed for issue \`${result.issueId}\`:\n\`\`\`\n${result.error}\n\`\`\``,
        );
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      await message.reply(`Error: ${errorMsg}`);
    }
  });

  await client.login(cfg.token);
  return client;
}
