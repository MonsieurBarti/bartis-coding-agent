import { describe, test, expect } from "bun:test";
import { parseMessage } from "../parser.ts";

const BOT_ID = "123456789";

describe("parseMessage", () => {
  test("parses mention with repo and task", () => {
    const result = parseMessage(`<@${BOT_ID}> /path/to/project Fix the login bug`, BOT_ID);
    expect(result).toEqual({
      repo: "/path/to/project",
      task: "Fix the login bug",
    });
  });

  test("handles nickname mention format", () => {
    const result = parseMessage(`<@!${BOT_ID}> my-repo Add dark mode`, BOT_ID);
    expect(result).toEqual({
      repo: "my-repo",
      task: "Add dark mode",
    });
  });

  test("returns null for empty message after stripping mention", () => {
    expect(parseMessage(`<@${BOT_ID}>`, BOT_ID)).toBeNull();
  });

  test("returns null for only repo, no task", () => {
    expect(parseMessage(`<@${BOT_ID}> /path/to/project`, BOT_ID)).toBeNull();
  });

  test("returns null for empty string", () => {
    expect(parseMessage("", BOT_ID)).toBeNull();
  });

  test("handles multiple words in task description", () => {
    const result = parseMessage(
      `<@${BOT_ID}> /repos/app Refactor the authentication module to use JWT tokens`,
      BOT_ID,
    );
    expect(result).toEqual({
      repo: "/repos/app",
      task: "Refactor the authentication module to use JWT tokens",
    });
  });
});
