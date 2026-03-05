import {
  Client,
  Events,
  GatewayIntentBits,
  type Message,
} from "discord.js";
import { loadConfig, type DiscordConfig } from "./config.ts";
import { parseMessage } from "./parser.ts";
import {
  dispatchConvoy,
  type ConvoyDispatchResult,
} from "../dispatch/convoy.ts";

/**
 * Run the full convoy pipeline for a Discord request:
 * 1. Create bd issue
 * 2. Create convoy to track it
 * 3. Sling work to a polecat
 * 4. Poll convoy status until landed/failed/timeout
 * 5. Return result with PR link
 */
async function handleTask(
  task: string,
  repo: string,
  onStatus?: (msg: string) => void,
): Promise<ConvoyDispatchResult> {
  return dispatchConvoy({
    task,
    rig: repo,
    args: task,
    onPoll: (status) => {
      const secs = Math.round(status.elapsed / 1000);
      onStatus?.(
        `Convoy \`${status.convoyId}\`: ${status.status} (${secs}s elapsed)`,
      );
    },
  });
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
      const result = await handleTask(parsed.task, parsed.repo, async (statusMsg) => {
        // Send periodic status updates to the thread
        try {
          await message.reply(statusMsg);
        } catch {
          // Ignore reply failures during polling
        }
      });

      if (result.success) {
        const prLine = result.prUrl
          ? `PR: ${result.prUrl}`
          : "No PR URL found (check the repo for recent PRs)";
        await message.reply(
          `Done! Issue: \`${result.issueId}\` | Convoy: \`${result.convoyId}\`\n${prLine}`,
        );
      } else {
        await message.reply(
          `Pipeline failed for issue \`${result.issueId}\` (convoy \`${result.convoyId}\`):\n` +
          `${result.summary}\n\`\`\`\n${result.error}\n\`\`\``,
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
