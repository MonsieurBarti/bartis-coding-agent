import {
  Client,
  Events,
  GatewayIntentBits,
  REST,
  Routes,
} from "discord.js";
import { loadConfig, type DiscordConfig } from "./config.ts";
import {
  workCommand,
  handleWorkCommand,
  handleWorkAutocomplete,
} from "./commands.ts";

/**
 * Register slash commands with Discord.
 */
async function registerCommands(config: DiscordConfig): Promise<void> {
  const rest = new REST({ version: "10" }).setToken(config.token);
  await rest.put(Routes.applicationCommands(config.appId), {
    body: [workCommand.toJSON()],
  });
  console.log("Registered slash commands");
}

/**
 * Start the Discord bot.
 *
 * Registers the /work slash command and handles interactions
 * in configured channels. On submit: creates bd issue, dispatches
 * convoy, and replies with live status updates.
 */
export async function startBot(config?: DiscordConfig): Promise<Client> {
  const cfg = config ?? loadConfig();

  // Register slash commands before connecting
  await registerCommands(cfg);

  const client = new Client({
    intents: [GatewayIntentBits.Guilds],
  });

  const channelSet = new Set(cfg.channelIds);

  client.once(Events.ClientReady, (readyClient) => {
    console.log(`Discord bot ready as ${readyClient.user.tag}`);
  });

  client.on(Events.InteractionCreate, async (interaction) => {
    // Only respond in configured channels
    if (interaction.channelId && !channelSet.has(interaction.channelId)) return;

    if (interaction.isAutocomplete()) {
      if (interaction.commandName === "work") {
        await handleWorkAutocomplete(interaction);
      }
      return;
    }

    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === "work") {
        await handleWorkCommand(interaction);
      }
      return;
    }
  });

  await client.login(cfg.token);
  return client;
}
