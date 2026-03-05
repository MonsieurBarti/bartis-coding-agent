import { describe, expect, test } from "bun:test";
import { parseProfile } from "../../profile";
import {
  buildCreatePrCommand,
  buildPrBody,
  type CreatePrContext,
  renderTemplate,
} from "../create-pr";

const PROFILE_YAML = `
project:
  language: typescript
  packageManager: bun
git:
  baseBranch: main
`;

const PROFILE_WITH_TEMPLATE = `
project:
  language: typescript
  packageManager: bun
git:
  baseBranch: develop
pr:
  template: |
    # {{title}}
    {{summary}}
    Tests: {{testResults}}
    Link: {{taskLink}}
`;

const profile = parseProfile(PROFILE_YAML);
const profileWithTemplate = parseProfile(PROFILE_WITH_TEMPLATE);

const fullCtx: CreatePrContext = {
  title: "Add login feature",
  summary: "Implemented OAuth login flow",
  testResults: "12 passed, 0 failed",
  taskLink: "https://example.com/issues/42",
};

const minCtx: CreatePrContext = {
  title: "Fix typo",
  summary: "Fixed typo in README",
};

describe("renderTemplate", () => {
  test("replaces all known placeholders", () => {
    const tpl = "{{title}} - {{summary}} ({{testResults}}) [{{taskLink}}]";
    const result = renderTemplate(tpl, fullCtx);
    expect(result).toBe(
      "Add login feature - Implemented OAuth login flow (12 passed, 0 failed) [https://example.com/issues/42]",
    );
  });

  test("replaces missing optional values with empty string", () => {
    const tpl = "{{title}}: {{testResults}}";
    const result = renderTemplate(tpl, minCtx);
    expect(result).toBe("Fix typo: ");
  });

  test("leaves unknown placeholders empty", () => {
    const tpl = "{{title}} {{unknown}}";
    const result = renderTemplate(tpl, minCtx);
    expect(result).toBe("Fix typo ");
  });

  test("handles template with no placeholders", () => {
    const result = renderTemplate("static text", minCtx);
    expect(result).toBe("static text");
  });
});

describe("buildPrBody", () => {
  test("uses default template when profile has none", () => {
    const body = buildPrBody(profile, fullCtx);
    expect(body).toContain("## Summary");
    expect(body).toContain("Implemented OAuth login flow");
    expect(body).toContain("## Test Results");
    expect(body).toContain("12 passed, 0 failed");
    expect(body).toContain("## Task");
    expect(body).toContain("https://example.com/issues/42");
  });

  test("uses custom template from profile", () => {
    const body = buildPrBody(profileWithTemplate, fullCtx);
    expect(body).toContain("# Add login feature");
    expect(body).toContain("Implemented OAuth login flow");
    expect(body).toContain("Tests: 12 passed, 0 failed");
    expect(body).toContain("Link: https://example.com/issues/42");
  });

  test("handles minimal context with default template", () => {
    const body = buildPrBody(profile, minCtx);
    expect(body).toContain("## Summary");
    expect(body).toContain("Fixed typo in README");
    // Optional fields resolve to empty, section headers still present
    expect(body).toContain("## Test Results");
    expect(body).toContain("## Task");
  });
});

describe("buildCreatePrCommand", () => {
  test("combines push and gh pr create", () => {
    const cmd = buildCreatePrCommand(profile, fullCtx);
    expect(cmd).toContain("git push -u origin HEAD");
    expect(cmd).toContain("&&");
    expect(cmd).toContain("gh pr create");
    expect(cmd).toContain("--base 'main'");
    expect(cmd).toContain("--title 'Add login feature'");
    expect(cmd).toContain("--body '");
  });

  test("uses custom branch when provided", () => {
    const ctx: CreatePrContext = { ...fullCtx, branch: "feature/login" };
    const cmd = buildCreatePrCommand(profile, ctx);
    expect(cmd).toContain("git push -u origin feature/login");
  });

  test("uses base branch from profile", () => {
    const cmd = buildCreatePrCommand(profileWithTemplate, fullCtx);
    expect(cmd).toContain("--base 'develop'");
  });

  test("escapes single quotes in title", () => {
    const ctx: CreatePrContext = {
      title: "Fix it's broken",
      summary: "The app's crash is fixed",
    };
    const cmd = buildCreatePrCommand(profile, ctx);
    expect(cmd).toContain("Fix it'\\''s broken");
  });

  test("body contains interpolated template", () => {
    const cmd = buildCreatePrCommand(profile, fullCtx);
    expect(cmd).toContain("Implemented OAuth login flow");
    expect(cmd).toContain("12 passed, 0 failed");
  });
});
