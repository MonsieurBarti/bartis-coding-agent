import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { loadConfig } from "../config.ts";

describe("loadConfig", () => {
  const origToken = process.env.DISCORD_TOKEN;
  const origAppId = process.env.DISCORD_APP_ID;
  const origChannel = process.env.DISCORD_CHANNEL_ID;

  afterEach(() => {
    if (origToken !== undefined) process.env.DISCORD_TOKEN = origToken;
    else delete process.env.DISCORD_TOKEN;
    if (origAppId !== undefined) process.env.DISCORD_APP_ID = origAppId;
    else delete process.env.DISCORD_APP_ID;
    if (origChannel !== undefined) process.env.DISCORD_CHANNEL_ID = origChannel;
    else delete process.env.DISCORD_CHANNEL_ID;
  });

  function setAllEnv() {
    process.env.DISCORD_TOKEN = "test-token";
    process.env.DISCORD_APP_ID = "test-app-id";
    process.env.DISCORD_CHANNEL_ID = "123";
  }

  test("throws when DISCORD_TOKEN is missing", () => {
    setAllEnv();
    delete process.env.DISCORD_TOKEN;
    expect(() => loadConfig()).toThrow("DISCORD_TOKEN");
  });

  test("throws when DISCORD_APP_ID is missing", () => {
    setAllEnv();
    delete process.env.DISCORD_APP_ID;
    expect(() => loadConfig()).toThrow("DISCORD_APP_ID");
  });

  test("throws when DISCORD_CHANNEL_ID is missing", () => {
    setAllEnv();
    delete process.env.DISCORD_CHANNEL_ID;
    expect(() => loadConfig()).toThrow("DISCORD_CHANNEL_ID");
  });

  test("parses single channel ID", () => {
    setAllEnv();
    process.env.DISCORD_CHANNEL_ID = "111";
    const config = loadConfig();
    expect(config.token).toBe("test-token");
    expect(config.appId).toBe("test-app-id");
    expect(config.channelIds).toEqual(["111"]);
  });

  test("parses comma-separated channel IDs", () => {
    setAllEnv();
    process.env.DISCORD_CHANNEL_ID = "111, 222, 333";
    const config = loadConfig();
    expect(config.channelIds).toEqual(["111", "222", "333"]);
  });

  test("filters empty channel IDs", () => {
    setAllEnv();
    process.env.DISCORD_CHANNEL_ID = "111,,222,";
    const config = loadConfig();
    expect(config.channelIds).toEqual(["111", "222"]);
  });
});
