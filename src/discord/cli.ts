#!/usr/bin/env bun
/**
 * CLI entry point: start the Discord bot.
 *
 * Usage: bun src/discord/cli.ts
 *
 * Requires DISCORD_TOKEN and DISCORD_CHANNEL_ID environment variables.
 */
import { startBot } from "./bot.ts";

await startBot();
