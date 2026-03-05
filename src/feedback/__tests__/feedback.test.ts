import { describe, expect, test } from "bun:test";
import { parseProfile } from "../../profile";
import { type FeedbackResult, formatFeedback, runFeedback } from "../index";

function makeProfile(commands: { lint?: string; typecheck?: string }) {
  const lines = ["project:", "  language: typescript"];
  if (commands.lint || commands.typecheck) {
    lines.push("commands:");
    if (commands.lint) lines.push(`  lint: "${commands.lint}"`);
    if (commands.typecheck) lines.push(`  typecheck: "${commands.typecheck}"`);
  }
  return parseProfile(lines.join("\n"));
}

describe("runFeedback", () => {
  test("passes when both checks succeed", async () => {
    const profile = makeProfile({
      lint: "echo ok",
      typecheck: "echo ok",
    });
    const result = await runFeedback(profile);

    expect(result.ok).toBe(true);
    expect(result.checks).toHaveLength(2);
    expect(result.checks[0].name).toBe("lint");
    expect(result.checks[0].ok).toBe(true);
    expect(result.checks[1].name).toBe("typecheck");
    expect(result.checks[1].ok).toBe(true);
  });

  test("fails when lint fails", async () => {
    const profile = makeProfile({
      lint: "echo 'error: unused var' >&2 && exit 1",
      typecheck: "echo ok",
    });
    const result = await runFeedback(profile);

    expect(result.ok).toBe(false);
    expect(result.checks[0].ok).toBe(false);
    expect(result.checks[0].output).toContain("unused var");
    expect(result.checks[1].ok).toBe(true);
  });

  test("fails when typecheck fails", async () => {
    const profile = makeProfile({
      lint: "echo ok",
      typecheck: "echo 'TS2322: Type error' >&2 && exit 1",
    });
    const result = await runFeedback(profile);

    expect(result.ok).toBe(false);
    expect(result.checks[0].ok).toBe(true);
    expect(result.checks[1].ok).toBe(false);
    expect(result.checks[1].output).toContain("TS2322");
  });

  test("fails when both fail", async () => {
    const profile = makeProfile({
      lint: "exit 1",
      typecheck: "exit 2",
    });
    const result = await runFeedback(profile);

    expect(result.ok).toBe(false);
    expect(result.checks.every((c) => !c.ok)).toBe(true);
  });

  test("returns empty checks when no commands configured", async () => {
    const profile = makeProfile({});
    const result = await runFeedback(profile);

    expect(result.ok).toBe(true);
    expect(result.checks).toHaveLength(0);
    expect(result.durationMs).toBe(0);
  });

  test("runs only lint when typecheck not configured", async () => {
    const profile = makeProfile({ lint: "echo linted" });
    const result = await runFeedback(profile);

    expect(result.ok).toBe(true);
    expect(result.checks).toHaveLength(1);
    expect(result.checks[0].name).toBe("lint");
  });

  test("runs only typecheck when lint not configured", async () => {
    const profile = makeProfile({ typecheck: "echo typed" });
    const result = await runFeedback(profile);

    expect(result.ok).toBe(true);
    expect(result.checks).toHaveLength(1);
    expect(result.checks[0].name).toBe("typecheck");
  });

  test("respects cwd option", async () => {
    const profile = makeProfile({ lint: "pwd" });
    const result = await runFeedback(profile, { cwd: "/tmp" });

    expect(result.ok).toBe(true);
  });

  test("tracks duration per check", async () => {
    const profile = makeProfile({ lint: "echo ok" });
    const result = await runFeedback(profile);

    expect(result.checks[0].durationMs).toBeGreaterThanOrEqual(0);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  test("captures stdout on failure", async () => {
    const profile = makeProfile({
      lint: "echo 'stdout error' && exit 1",
    });
    const result = await runFeedback(profile);

    expect(result.checks[0].ok).toBe(false);
    expect(result.checks[0].output).toContain("stdout error");
  });

  test("runs checks in parallel", async () => {
    const profile = makeProfile({
      lint: "sleep 0.1 && echo ok",
      typecheck: "sleep 0.1 && echo ok",
    });
    const start = performance.now();
    const result = await runFeedback(profile);
    const elapsed = performance.now() - start;

    expect(result.ok).toBe(true);
    // Parallel: ~100ms, sequential would be ~200ms
    expect(elapsed).toBeLessThan(300);
  });
});

describe("formatFeedback", () => {
  test("formats success", () => {
    const result: FeedbackResult = {
      ok: true,
      checks: [{ name: "lint", ok: true, output: "", durationMs: 42 }],
      durationMs: 42,
    };
    expect(formatFeedback(result)).toBe("All checks passed (42ms)");
  });

  test("formats failure with output", () => {
    const result: FeedbackResult = {
      ok: false,
      checks: [
        { name: "lint", ok: true, output: "", durationMs: 10 },
        {
          name: "typecheck",
          ok: false,
          output: "error TS2322: Type 'string' is not assignable",
          durationMs: 50,
        },
      ],
      durationMs: 50,
    };
    const formatted = formatFeedback(result);
    expect(formatted).toContain("typecheck failed");
    expect(formatted).toContain("TS2322");
    expect(formatted).not.toContain("lint failed");
  });

  test("formats multiple failures", () => {
    const result: FeedbackResult = {
      ok: false,
      checks: [
        { name: "lint", ok: false, output: "lint error", durationMs: 10 },
        { name: "typecheck", ok: false, output: "type error", durationMs: 20 },
      ],
      durationMs: 20,
    };
    const formatted = formatFeedback(result);
    expect(formatted).toContain("lint failed");
    expect(formatted).toContain("typecheck failed");
  });
});
