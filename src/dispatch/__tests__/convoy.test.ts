import { describe, test, expect, mock, beforeEach } from "bun:test";
import {
  createIssue,
  createConvoy,
  slingWork,
  getConvoyStatus,
  dispatchConvoy,
} from "../convoy";

// Mock Bun.spawn for CLI calls
const originalSpawn = Bun.spawn;

function mockSpawn(
  responses: Array<{ stdout: string; stderr?: string; exitCode?: number }>,
) {
  let callIndex = 0;
  const calls: Array<string[]> = [];

  // @ts-expect-error — mock override
  Bun.spawn = (cmd: string[], opts?: Record<string, unknown>) => {
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

  return { calls, restore: () => { Bun.spawn = originalSpawn; } };
}

describe("createIssue", () => {
  test("parses issue ID from bd create output", async () => {
    const { restore } = mockSpawn([
      { stdout: JSON.stringify({ id: "bca-abc123" }) },
    ]);
    try {
      const id = await createIssue("Fix login", "/path/to/repo");
      expect(id).toBe("bca-abc123");
    } finally {
      restore();
    }
  });

  test("parses issue ID from array response", async () => {
    const { restore } = mockSpawn([
      { stdout: JSON.stringify([{ id: "bca-def456" }]) },
    ]);
    try {
      const id = await createIssue("Add tests", "/repo");
      expect(id).toBe("bca-def456");
    } finally {
      restore();
    }
  });

  test("throws on bd create failure", async () => {
    const { restore } = mockSpawn([
      { stdout: "", stderr: "database error", exitCode: 1 },
    ]);
    try {
      let caught: Error | null = null;
      try {
        await createIssue("Task", "/repo");
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

describe("createConvoy", () => {
  test("extracts convoy ID from hq-* pattern", async () => {
    const { restore } = mockSpawn([
      { stdout: "Created convoy hq-convoy123 tracking 1 issue" },
    ]);
    try {
      const id = await createConvoy("bca-abc", "Fix login");
      expect(id).toBe("hq-convoy123");
    } finally {
      restore();
    }
  });

  test("extracts convoy ID from JSON response", async () => {
    const { restore } = mockSpawn([
      { stdout: JSON.stringify({ id: "hq-json456" }) },
    ]);
    try {
      const id = await createConvoy("bca-abc", "Fix login");
      expect(id).toBe("hq-json456");
    } finally {
      restore();
    }
  });

  test("throws when no convoy ID found", async () => {
    const { restore } = mockSpawn([
      { stdout: "Something happened but no ID" },
    ]);
    try {
      let caught: Error | null = null;
      try {
        await createConvoy("bca-abc", "Task");
      } catch (err) {
        caught = err as Error;
      }
      expect(caught).not.toBeNull();
      expect(caught!.message).toContain("Failed to parse convoy ID");
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
      expect(calls[0]).toEqual(["gt", "sling", "bca-abc", "myrig"]);
    } finally {
      restore();
    }
  });

  test("passes --args when provided", async () => {
    const { calls, restore } = mockSpawn([{ stdout: "Slung!" }]);
    try {
      await slingWork("bca-abc", "myrig", "focus on tests");
      expect(calls[0]).toEqual([
        "gt", "sling", "bca-abc", "myrig", "--args", "focus on tests",
      ]);
    } finally {
      restore();
    }
  });
});

describe("getConvoyStatus", () => {
  test("parses convoy status JSON", async () => {
    const { restore } = mockSpawn([
      {
        stdout: JSON.stringify({
          status: "active",
          members: [
            { id: "bca-abc", status: "in_progress" },
          ],
        }),
      },
    ]);
    try {
      const status = await getConvoyStatus("hq-123");
      expect(status).toEqual({
        status: "active",
        members: [{ id: "bca-abc", status: "in_progress" }],
      });
    } finally {
      restore();
    }
  });

  test("returns null on failure", async () => {
    const { restore } = mockSpawn([
      { stdout: "", exitCode: 1 },
    ]);
    try {
      const status = await getConvoyStatus("hq-nonexistent");
      expect(status).toBeNull();
    } finally {
      restore();
    }
  });
});

describe("dispatchConvoy", () => {
  test("returns success when convoy lands", async () => {
    const { restore } = mockSpawn([
      // 1. createIssue -> bd create
      { stdout: JSON.stringify({ id: "bca-issue1" }) },
      // 2. createConvoy -> gt convoy create
      { stdout: "Created convoy hq-conv1 tracking 1 issue" },
      // 3. slingWork -> gt sling
      { stdout: "Slung bca-issue1 to myrig" },
      // 4. First poll -> gt convoy status
      {
        stdout: JSON.stringify({
          status: "landed",
          members: [{ id: "bca-issue1", status: "closed" }],
        }),
      },
      // 5. findPrUrl -> bd show
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
      expect(result.convoyId).toBe("hq-conv1");
      expect(result.prUrl).toBe("https://github.com/org/repo/pull/42");
    } finally {
      restore();
    }
  });

  test("returns failure when convoy fails", async () => {
    const { restore } = mockSpawn([
      // createIssue
      { stdout: JSON.stringify({ id: "bca-issue2" }) },
      // createConvoy
      { stdout: "Created convoy hq-conv2" },
      // slingWork
      { stdout: "Slung" },
      // poll -> failed
      { stdout: JSON.stringify({ status: "failed", members: [] }) },
    ]);

    try {
      const result = await dispatchConvoy({
        task: "Bad task",
        rig: "myrig",
        pollIntervalMs: 10,
        timeoutMs: 5000,
      });
      expect(result.success).toBe(false);
      expect(result.convoyId).toBe("hq-conv2");
      expect(result.error).toContain("failed");
    } finally {
      restore();
    }
  });

  test("returns failure when sling fails", async () => {
    const { restore } = mockSpawn([
      // createIssue
      { stdout: JSON.stringify({ id: "bca-issue3" }) },
      // createConvoy
      { stdout: "Created convoy hq-conv3" },
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
