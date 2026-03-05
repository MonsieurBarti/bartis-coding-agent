import { describe, expect, test } from "bun:test";
import { workCommand } from "../commands.ts";

describe("workCommand", () => {
  const json = workCommand.toJSON();

  test("has correct name and description", () => {
    expect(json.name).toBe("work");
    expect(json.description).toBe("Dispatch a task to a polecat worker");
  });

  test("has three required options", () => {
    expect(json.options).toHaveLength(3);
    for (const opt of json.options!) {
      expect(opt.required).toBe(true);
    }
  });

  test("type option has four choices", () => {
    const typeOpt = json.options!.find((o) => o.name === "type");
    expect(typeOpt).toBeDefined();
    expect((typeOpt as any).choices).toHaveLength(4);
    const values = (typeOpt as any).choices.map((c: any) => c.value);
    expect(values).toEqual(["feature", "bugfix", "task", "chore"]);
  });

  test("project option has autocomplete enabled", () => {
    const projectOpt = json.options!.find((o) => o.name === "project");
    expect(projectOpt).toBeDefined();
    expect((projectOpt as any).autocomplete).toBe(true);
  });

  test("description option is a string", () => {
    const descOpt = json.options!.find((o) => o.name === "description");
    expect(descOpt).toBeDefined();
    // ApplicationCommandOptionType.String = 3
    expect(descOpt!.type).toBe(3);
  });
});
