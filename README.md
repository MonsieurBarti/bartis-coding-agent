# bca — Blueprint Coding Agent

A Discord-integrated AI coding pipeline that dispatches tasks to autonomous worker agents (polecats) via Gas Town. Users submit work through Discord slash commands, and bca orchestrates the full cycle: issue creation, convoy tracking, codebase analysis, agent-driven implementation, feedback loops, and PR creation.

## Architecture

```
Discord                    Gas Town                    Target Project
──────                    ────────                    ──────────────
/work command ──┐
                │
  @bot message ─┼──► Discord Bot ──► Convoy Dispatch ──► Polecat Worker
                │     (bot.ts)       (convoy.ts)          │
                │                                         ▼
  Live status ◄─┤◄── Status Embed ◄── bd/gt polling    Blueprint Engine
  (embed updates)     (embed.ts)                         │
                                                    ┌────┼────┐
                                                    ▼    ▼    ▼
                                                Understand → Implement → Verify
                                                (code-graph)  (Pi SDK)   (tests)
                                                    │
                                                    ▼
                                                Feedback Loop
                                                (lint + typecheck)
                                                    │
                                                    ▼
                                                Push + PR
```

### Modules

| Module | Purpose |
|--------|---------|
| `src/discord/` | Discord bot, `/work` slash command, message parser |
| `src/dispatch/` | Convoy-based dispatch (issue → convoy → sling → poll) and blueprint dispatch |
| `src/blueprint/` | DAG engine: topological sort, node execution, context assembly |
| `src/project/` | Project registry (`~/.bca/projects.yaml`) with Zod validation |
| `src/profile/` | Per-project pipeline profile (`.pi/pipeline.yaml`) |
| `src/runner/` | Pi SDK agent runner with headless session management |
| `src/extensions/` | code-graph tools registered as Pi agent extensions |
| `src/feedback/` | Lint + typecheck feedback loop for agent iterations |
| `src/nodes/` | PR creation (template rendering, `gh pr create`) |
| `src/status/` | Pipeline status collection and Discord embed rendering |

## Prerequisites

- **[Bun](https://bun.sh/)** v1.0+ — runtime and package manager
- **[Pi SDK](https://github.com/nicepkg/pi)** (`@mariozechner/pi-coding-agent`) — agent execution backend
- **[Gas Town](https://github.com/...)** (`gt`, `bd`) — work dispatch, convoy tracking, issue management
- **[code-graph](https://github.com/nicepkg/code-graph)** — codebase indexing for context assembly
- **Discord Bot Token** — from the [Discord Developer Portal](https://discord.com/developers/applications)
- **GitHub CLI** (`gh`) — for PR creation

## Installation

```bash
# Clone the repository
git clone <repo-url>
cd bca

# Install dependencies
bun install
```

## Discord App Setup

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications)
2. Create a new application
3. Go to **Bot** → click **Add Bot**
4. Enable these **Privileged Gateway Intents**:
   - Message Content Intent
   - Server Members Intent (optional)
5. Copy the **Bot Token** — you'll need it for `DISCORD_TOKEN`
6. Go to **OAuth2 → URL Generator**:
   - Scopes: `bot`, `applications.commands`
   - Bot Permissions: `Send Messages`, `Read Message History`, `Use Slash Commands`
7. Use the generated URL to invite the bot to your server
8. Copy the **Application ID** from the General Information page — you'll need it for `DISCORD_APP_ID`
9. Right-click the channel(s) you want the bot to listen in → **Copy Channel ID** (enable Developer Mode in Discord settings if needed)

### Environment Variables

```bash
export DISCORD_TOKEN="your-bot-token"
export DISCORD_APP_ID="your-application-id"
export DISCORD_CHANNEL_ID="channel-id-1,channel-id-2"  # comma-separated
```

## Project Registry (`~/.bca/projects.yaml`)

The project registry defines which projects can be targeted from Discord. Located at `~/.bca/projects.yaml`:

```yaml
default: my-app

projects:
  my-app:
    repo: https://github.com/org/my-app
    branch: main
    profile: .pi/pipeline.yaml
    language: typescript
    description: Main web application

  api-server:
    repo: https://github.com/org/api-server
    branch: develop
    profile: .pi/pipeline.yaml
    language: go
    description: Backend API service
```

### Fields

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `default` | yes | — | Default project name when none specified |
| `projects.<name>.repo` | yes | — | Git repository URL |
| `projects.<name>.branch` | no | `main` | Default branch |
| `projects.<name>.profile` | no | `.pi/pipeline.yaml` | Path to pipeline profile |
| `projects.<name>.language` | yes | — | Project language (e.g., `typescript`, `go`) |
| `projects.<name>.description` | no | — | Shown in Discord autocomplete |

## Pipeline Profile (`.pi/pipeline.yaml`)

Each target project needs a `.pi/pipeline.yaml` in its root. This tells bca how to build, test, and lint the project:

```yaml
project:
  language: typescript
  packageManager: bun

commands:
  install: bun install
  lint: bun run lint
  test: bun test
  build: bun run build
  typecheck: bun run tsc --noEmit

tools:
  - read
  - write
  - edit
  - bash
  - grep
  - glob

rules:
  - Use functional patterns, avoid classes where possible
  - Keep files under 300 lines

git:
  baseBranch: main
  commitPrefix: "feat: "

pr:
  template: |
    ## Summary
    {{summary}}

    ## Test Results
    {{testResults}}
```

All `commands` fields are optional — omit any that don't apply. The `tools` array controls which Pi SDK tools are available to the agent. The `rules` array provides project-specific instructions injected into the agent prompt.

## Running the Bot

### Discord Bot (slash commands + mentions)

```bash
bun src/discord/cli.ts
```

Listens for:
- **`/work`** slash command — structured input with project autocomplete
- **`@bot <repo> <task>`** — mention-based freeform requests

### Direct Agent Runner (no Discord)

```bash
bun src/runner/cli.ts \
  --task "Fix the login page styling" \
  --project /path/to/project \
  --blueprint /path/to/blueprint.yaml  # optional
```

Options:
- `-t, --task` — Task description (required)
- `-p, --project` — Absolute path to project root (required)
- `-b, --blueprint` — Custom blueprint YAML (optional, uses default pipeline if omitted)
- `--cwd` — Working directory override

## Slash Command Usage

### `/work`

Dispatches a task to a polecat worker agent.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `type` | yes | Work type: Feature, Bugfix, Task, or Chore |
| `project` | yes | Target project (autocomplete from registry) |
| `description` | yes | What needs to be done |

Example: `/work type:Feature project:my-app description:Add dark mode toggle to settings page`

The bot will:
1. Create a `bd` issue for the task
2. Create a convoy to track progress
3. Sling the work to an available polecat
4. Reply with a live-updating status embed showing stage, priority, elapsed time, test results, and convoy members
5. Update the embed every 15 seconds until the pipeline completes or times out (30 min)
6. Add the PR link to the embed on completion

### Mention-based Requests

```
@bot /path/to/project Fix the login page styling
```

The bot parses the first token as the repo path and everything after as the task description. It dispatches through the convoy pipeline and replies with progress updates.

## How Convoys Track Work

A **convoy** wraps a Discord request into a trackable unit through the Gas Town dispatch system:

1. **Issue Creation** — `bd create` creates a bead (issue) for the task
2. **Convoy Creation** — `gt convoy create` wraps the issue in a convoy for lifecycle tracking
3. **Work Dispatch** — `gt sling` assigns the issue to a polecat worker in the target rig
4. **Status Polling** — `gt convoy status` is polled every 10s (default) to check progress
5. **Completion** — When the convoy lands (all issues closed), the PR URL is extracted from the bead

Convoy statuses: `landed`, `closed`, `complete`, `done` (success) or `failed`, `error`, `cancelled` (failure). Timeout default is 10 minutes for the convoy pipeline, 30 minutes for the slash command poller.

## Blueprint Engine

The blueprint engine executes task pipelines as DAGs. Each node has a type and dependencies:

| Node Type | Description |
|-----------|-------------|
| `deterministic` | Shell command — fails on non-zero exit |
| `agent` | Pi SDK agent with prompt, optional context assembly, feedback loop |
| `understand` | Analyzes codebase via code-graph, writes implementation plan |
| `fix` | Test → agent fix → retest loop |
| `ci-gate` | Test → autofix → retest loop (deterministic, no LLM) |
| `git-setup` | Create branch/worktree from base branch |

The default pipeline (when no custom blueprint is provided) is:

```
understand → implement → verify
```

- **understand**: Queries code-graph for project stats and structure, produces a plan
- **implement**: Agent node that executes the task (up to 3 feedback iterations with lint/typecheck)
- **verify**: Runs the project's test command

## Troubleshooting

### Bot doesn't respond to messages
- Verify `DISCORD_TOKEN` is set and valid
- Verify `DISCORD_CHANNEL_ID` includes the channel you're posting in
- Ensure Message Content Intent is enabled in the Developer Portal
- Check the bot has permissions to read and send messages in the channel

### `/work` command not appearing
- The slash command needs to be registered with Discord. Ensure `DISCORD_APP_ID` is set
- Re-invite the bot with the `applications.commands` scope

### "Unknown project" error
- Check `~/.bca/projects.yaml` exists and is valid YAML
- Verify the project name matches exactly (case-sensitive)
- Run validation: `bun -e "import { loadProjectRegistry } from './src/project'; loadProjectRegistry().then(console.log)"`

### Convoy times out
- Default timeout is 10 minutes. Check if the polecat worker is running
- Verify `gt` and `bd` CLIs are available on PATH
- Check Gas Town status: `gt dolt status`

### Agent fails during implementation
- Ensure `.pi/pipeline.yaml` exists in the target project
- Verify the `commands.test` / `commands.lint` / `commands.typecheck` commands work standalone
- Check that `code-graph` binary is available for context assembly

### Pipeline profile validation fails
- Run: `bun -e "import { loadProfile } from './src/profile'; loadProfile('/path/to/project').then(console.log).catch(console.error)"`
- Common issues: missing `project.language` field, invalid command paths

### Tests

```bash
bun test
```

Runs the full test suite across all modules (blueprint, discord, dispatch, project, profile, feedback, etc.).
