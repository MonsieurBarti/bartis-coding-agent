import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execute, parseBlueprint } from "../index";

/** Env vars that git sets during hooks — must be stripped so test subprocesses use their own repo. */
const GIT_HOOK_ENV_VARS = ["GIT_INDEX_FILE", "GIT_DIR", "GIT_WORK_TREE", "GIT_QUARANTINE_PATH"];

function cleanGitEnv(): Record<string, string | undefined> {
  const env = { ...process.env };
  for (const key of GIT_HOOK_ENV_VARS) {
    delete env[key];
  }
  return env;
}

/** Create a bare git repo and a clone to work in. Returns { bare, clone }. */
async function makeTestRepo(): Promise<{ bare: string; clone: string }> {
  const base = await mkdtemp(join(tmpdir(), "git-setup-test-"));
  const bare = join(base, "origin.git");
  const clone = join(base, "work");

  // Create bare "origin" with an initial commit
  await run(["git", "init", "--bare", bare]);
  await run(["git", "clone", bare, clone]);
  await run(["git", "commit", "--allow-empty", "-m", "init"], clone);
  await run(["git", "push", "origin", "main"], clone);

  return { bare, clone };
}

async function run(args: string[], cwd?: string): Promise<void> {
  const proc = Bun.spawn(args, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...cleanGitEnv(),
      GIT_AUTHOR_NAME: "test",
      GIT_AUTHOR_EMAIL: "test@test",
      GIT_COMMITTER_NAME: "test",
      GIT_COMMITTER_EMAIL: "test@test",
    },
  });
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`${args.join(" ")} failed: ${stderr}`);
  }
}

async function currentBranch(cwd: string): Promise<string> {
  const proc = Bun.spawn(["git", "branch", "--show-current"], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: cleanGitEnv(),
  });
  await proc.exited;
  return (await new Response(proc.stdout).text()).trim();
}

describe("git-setup node", () => {
  let repo: { bare: string; clone: string };
  const savedCwd = process.cwd();

  beforeEach(async () => {
    repo = await makeTestRepo();
    process.chdir(repo.clone);
  });

  afterEach(async () => {
    process.chdir(savedCwd);
    await rm(join(repo.bare, ".."), { recursive: true, force: true });
  });

  test("parses git-setup node from YAML", () => {
    const bp = parseBlueprint(`
name: git-test
nodes:
  setup:
    type: git-setup
    branch: feat/my-feature
    baseBranch: main
`);
    expect(bp.nodes.setup.type).toBe("git-setup");
    if (bp.nodes.setup.type === "git-setup") {
      expect(bp.nodes.setup.branch).toBe("feat/my-feature");
      expect(bp.nodes.setup.baseBranch).toBe("main");
    }
  });

  test("defaults baseBranch to main", () => {
    const bp = parseBlueprint(`
name: git-test
nodes:
  setup:
    type: git-setup
    branch: feat/quick
`);
    if (bp.nodes.setup.type === "git-setup") {
      expect(bp.nodes.setup.baseBranch).toBe("main");
    }
  });

  test("creates branch from base (no worktree)", async () => {
    const bp = parseBlueprint(`
name: branch-only
nodes:
  setup:
    type: git-setup
    branch: feat/test-branch
    baseBranch: main
`);
    const result = await execute(bp);
    expect(result.success).toBe(true);
    expect(result.states.get("setup")!.status).toBe("success");

    const branch = await currentBranch(repo.clone);
    expect(branch).toBe("feat/test-branch");
  });

  test("creates branch with worktree", async () => {
    const worktreePath = join(repo.clone, "..", "wt");
    const bp = parseBlueprint(`
name: worktree-setup
nodes:
  setup:
    type: git-setup
    branch: feat/wt-branch
    baseBranch: main
    worktree: "${worktreePath}"
`);
    const result = await execute(bp);
    expect(result.success).toBe(true);
    expect(result.states.get("setup")!.status).toBe("success");

    // Verify the worktree branch exists
    const branch = await currentBranch(worktreePath);
    expect(branch).toBe("feat/wt-branch");
  });

  test("fails on invalid base branch", async () => {
    const bp = parseBlueprint(`
name: bad-base
nodes:
  setup:
    type: git-setup
    branch: feat/nope
    baseBranch: nonexistent
`);
    const result = await execute(bp);
    expect(result.success).toBe(false);
    expect(result.states.get("setup")!.status).toBe("failure");
    expect(result.states.get("setup")!.error).toContain("git fetch failed");
  });

  test("skips downstream when git-setup fails", async () => {
    const bp = parseBlueprint(`
name: fail-chain
nodes:
  setup:
    type: git-setup
    branch: feat/nope
    baseBranch: nonexistent
  build:
    type: deterministic
    command: "echo building"
    deps: [setup]
`);
    const result = await execute(bp);
    expect(result.success).toBe(false);
    expect(result.states.get("setup")!.status).toBe("failure");
    expect(result.states.get("build")!.status).toBe("skipped");
  });
});
