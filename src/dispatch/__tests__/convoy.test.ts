import { describe, expect, test } from "bun:test";
import { createIssue, dispatchConvoy, getIssueStatus, slingWork } from "../convoy";

// Mock Bun.spawn for CLI calls
const originalSpawn = Bun.spawn;

function mockSpawn(responses: Array<{ stdout: string; stderr?: string; exitCode?: number }>) {
  let callIndex = 0;
  const calls: Array<string[]> = [];

  // @ts-expect-error — mock override
  Bun.spawn = (cmd: string[], _opts?: Record<string, unknown>) => {
    calls.push(cmd);
    const resp = responses[callIndex] ?? { stdout: "", exitCode: 0 };
    callIndex++;

    const stdoutStream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(resp.stdout));
        controller.close();
      },
    });
    const stderrStream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(resp.stderr ?? ""));
        controller.close();
      },
    });

    return {
      stdout: stdoutStream,
      stderr: stderrStream,
      exitCode: resp.exitCode ?? 0,
      exited: Promise.resolve(resp.exitCode ?? 0),
      pid: 12345,
      kill: () => {},
    };
  };

  return {
    calls,
    restore: () => {
      Bun.spawn = originalSpawn;
    },
  };
}

describe("createIssue", () => {
  test("parses issue ID from bd create output", async () => {
    const { restore } = mockSpawn([{ stdout: JSON.stringify({ id: "bca-abc123" }) }]);
    try {
      const id = await createIssue("Fix login bug");
      expect(id).toBe("bca-abc123");
    } finally {
      restore();
    }
  });

  test("parses issue ID from array response", async () => {
    const { restore } = mockSpawn([{ stdout: JSON.stringify([{ id: "bca-def456" }]) }]);
    try {
      const id = await createIssue("Add tests", "bug");
      expect(id).toBe("bca-def456");
    } finally {
      restore();
    }
  });

  test("passes issue type to bd create", async () => {
    const { calls, restore } = mockSpawn([{ stdout: JSON.stringify({ id: "bca-typed" }) }]);
    try {
      await createIssue("Fix crash", "bug");
      expect(calls[0]).toEqual(["bd", "create", "--json", "-t", "bug", "Fix crash"]);
    } finally {
      restore();
    }
  });

  test("passes description when provided", async () => {
    const { calls, restore } = mockSpawn([{ stdout: JSON.stringify({ id: "bca-desc" }) }]);
    try {
      await createIssue("Fix crash", "bug", "Detailed description here");
      expect(calls[0]).toEqual([
        "bd",
        "create",
        "--json",
        "-t",
        "bug",
        "--description=Detailed description here",
        "Fix crash",
      ]);
    } finally {
      restore();
    }
  });

  test("throws on bd create failure", async () => {
    const { restore } = mockSpawn([{ stdout: "", stderr: "database error", exitCode: 1 }]);
    try {
      let caught: Error | null = null;
      try {
        await createIssue("Task");
      } catch (err) {
        caught = err as Error;
      }
      expect(caught).not.toBeNull();
      expect(caught!.message).toContain("bd create failed");
    } finally {
      restore();
    }
  });
});

describe("slingWork", () => {
  test("calls gt sling with issue and rig", async () => {
    const { calls, restore } = mockSpawn([{ stdout: "Slung!" }]);
    try {
      await slingWork("bca-abc", "myrig");
      expect(calls[0]).toEqual(["gt", "sling", "bca-abc", "myrig", "--merge=local"]);
    } finally {
      restore();
    }
  });

  test("passes --args when provided", async () => {
    const { calls, restore } = mockSpawn([{ stdout: "Slung!" }]);
    try {
      await slingWork("bca-abc", "myrig", "focus on tests");
      expect(calls[0]).toEqual([
        "gt",
        "sling",
        "bca-abc",
        "myrig",
        "--merge=local",
        "--args",
        "focus on tests",
      ]);
    } finally {
      restore();
    }
  });
});

describe("getIssueStatus", () => {
  test("parses issue status from bd show", async () => {
    const { restore } = mockSpawn([
      {
        stdout: JSON.stringify({
          id: "bca-abc",
          status: "hooked",
          assignee: "bca/polecats/immortan",
        }),
      },
    ]);
    try {
      const status = await getIssueStatus("bca-abc");
      expect(status).toEqual({
        status: "hooked",
        assignee: "bca/polecats/immortan",
      });
    } finally {
      restore();
    }
  });

  test("returns null on failure", async () => {
    const { restore } = mockSpawn([{ stdout: "", exitCode: 1 }]);
    try {
      const status = await getIssueStatus("bca-nonexistent");
      expect(status).toBeNull();
    } finally {
      restore();
    }
  });
});

describe("dispatchConvoy", () => {
  test("returns success when issue closes", async () => {
    const { restore } = mockSpawn([
      // 1. createIssue -> bd create
      { stdout: JSON.stringify({ id: "bca-issue1" }) },
      // 2. slingWork -> gt sling
      { stdout: "Slung bca-issue1 to myrig" },
      // 3. First poll -> bd show (closed)
      { stdout: JSON.stringify({ id: "bca-issue1", status: "closed" }) },
      // 4. findPrUrl -> bd show
      {
        stdout: JSON.stringify({
          id: "bca-issue1",
          notes: "PR: https://github.com/org/repo/pull/42",
        }),
      },
    ]);

    try {
      const result = await dispatchConvoy({
        task: "Fix login",
        rig: "myrig",
        pollIntervalMs: 10,
        timeoutMs: 5000,
      });
      expect(result.success).toBe(true);
      expect(result.issueId).toBe("bca-issue1");
      expect(result.prUrl).toBe("https://github.com/org/repo/pull/42");
    } finally {
      restore();
    }
  });

  test("returns failure when issue fails", async () => {
    const { restore } = mockSpawn([
      // createIssue
      { stdout: JSON.stringify({ id: "bca-issue2" }) },
      // slingWork
      { stdout: "Slung" },
      // poll -> failed
      { stdout: JSON.stringify({ id: "bca-issue2", status: "failed" }) },
    ]);

    try {
      const result = await dispatchConvoy({
        task: "Bad task",
        rig: "myrig",
        pollIntervalMs: 10,
        timeoutMs: 5000,
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain("failed");
    } finally {
      restore();
    }
  });

  test("returns failure when sling fails", async () => {
    const { restore } = mockSpawn([
      // createIssue
      { stdout: JSON.stringify({ id: "bca-issue3" }) },
      // slingWork -> fails
      { stdout: "", stderr: "No available polecats", exitCode: 1 },
    ]);

    try {
      const result = await dispatchConvoy({
        task: "Task",
        rig: "myrig",
        pollIntervalMs: 10,
      });
      expect(result.success).toBe(false);
      expect(result.summary).toBe("Failed to sling work");
    } finally {
      restore();
    }
  });
});
