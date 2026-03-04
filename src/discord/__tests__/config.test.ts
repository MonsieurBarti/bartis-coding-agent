import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { loadConfig } from "../config.ts";

describe("loadConfig", () => {
  const origToken = process.env.DISCORD_TOKEN;
  const origChannel = process.env.DISCORD_CHANNEL_ID;

  afterEach(() => {
    if (origToken !== undefined) process.env.DISCORD_TOKEN = origToken;
    else delete process.env.DISCORD_TOKEN;
    if (origChannel !== undefined) process.env.DISCORD_CHANNEL_ID = origChannel;
    else delete process.env.DISCORD_CHANNEL_ID;
  });

  test("throws when DISCORD_TOKEN is missing", () => {
    delete process.env.DISCORD_TOKEN;
    process.env.DISCORD_CHANNEL_ID = "123";
    expect(() => loadConfig()).toThrow("DISCORD_TOKEN");
  });

  test("throws when DISCORD_CHANNEL_ID is missing", () => {
    process.env.DISCORD_TOKEN = "test-token";
    delete process.env.DISCORD_CHANNEL_ID;
    expect(() => loadConfig()).toThrow("DISCORD_CHANNEL_ID");
  });

  test("parses single channel ID", () => {
    process.env.DISCORD_TOKEN = "test-token";
    process.env.DISCORD_CHANNEL_ID = "111";
    const config = loadConfig();
    expect(config.token).toBe("test-token");
    expect(config.channelIds).toEqual(["111"]);
  });

  test("parses comma-separated channel IDs", () => {
    process.env.DISCORD_TOKEN = "test-token";
    process.env.DISCORD_CHANNEL_ID = "111, 222, 333";
    const config = loadConfig();
    expect(config.channelIds).toEqual(["111", "222", "333"]);
  });

  test("filters empty channel IDs", () => {
    process.env.DISCORD_TOKEN = "test-token";
    process.env.DISCORD_CHANNEL_ID = "111,,222,";
    const config = loadConfig();
    expect(config.channelIds).toEqual(["111", "222"]);
  });
});
