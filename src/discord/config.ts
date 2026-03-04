export interface DiscordConfig {
  /** Discord bot token. */
  token: string;
  /** Comma-separated channel IDs the bot listens in. */
  channelIds: string[];
}

/**
 * Load Discord bot configuration from environment variables.
 *
 * Required:
 *   DISCORD_TOKEN       — Bot authentication token
 *   DISCORD_CHANNEL_ID  — Comma-separated list of channel IDs to listen in
 */
export function loadConfig(): DiscordConfig {
  const token = process.env.DISCORD_TOKEN;
  if (!token) {
    throw new Error("DISCORD_TOKEN environment variable is required");
  }

  const rawChannels = process.env.DISCORD_CHANNEL_ID;
  if (!rawChannels) {
    throw new Error("DISCORD_CHANNEL_ID environment variable is required");
  }

  const channelIds = rawChannels
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);

  if (channelIds.length === 0) {
    throw new Error("DISCORD_CHANNEL_ID must contain at least one channel ID");
  }

  return { token, channelIds };
}
