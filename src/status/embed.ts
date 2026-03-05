/**
 * Discord embed builder for pipeline status.
 *
 * Returns plain StatusEmbed objects that match the discord.js APIEmbed shape.
 * The consuming Discord bot can pass these directly to EmbedBuilder or
 * use them as embed JSON in message payloads.
 */

import { collectTestResults, deriveStage, fetchBeadStatus, fetchConvoyStatus } from "./collector";
import type {
  ConvoyStatus,
  EmbedField,
  PipelineStage,
  PipelineStatus,
  StatusEmbed,
  TestResults,
  TokenUsage,
} from "./types";

/** Stage display configuration. */
const STAGE_CONFIG: Record<PipelineStage, { emoji: string; color: number }> = {
  queued: { emoji: "\u{23F3}", color: 0x95a5a6 }, // hourglass, grey
  designing: { emoji: "\u{1F4D0}", color: 0x3498db }, // triangular ruler, blue
  implementing: { emoji: "\u{1F528}", color: 0xe67e22 }, // hammer, orange
  testing: { emoji: "\u{1F9EA}", color: 0x9b59b6 }, // test tube, purple
  reviewing: { emoji: "\u{1F50D}", color: 0xf1c40f }, // magnifying glass, yellow
  merging: { emoji: "\u{1F500}", color: 0x1abc9c }, // shuffle, teal
  complete: { emoji: "\u{2705}", color: 0x2ecc71 }, // check, green
  failed: { emoji: "\u{274C}", color: 0xe74c3c }, // X, red
  unknown: { emoji: "\u{2753}", color: 0x95a5a6 }, // question, grey
};

/**
 * Collect pipeline status from bd/gt and build a Discord embed.
 *
 * @param beadId - The bead ID to query (e.g., "bca-1ta")
 * @param options - Optional overrides for test results, token usage, etc.
 */
export async function buildStatusEmbed(
  beadId: string,
  options?: {
    testCommand?: string;
    testResults?: TestResults;
    tokenUsage?: TokenUsage;
    startedAt?: number;
  },
): Promise<StatusEmbed> {
  const startedAt = options?.startedAt ?? Date.now();
  const [bead, convoy] = await Promise.all([fetchBeadStatus(beadId), fetchConvoyStatus()]);

  const stage = deriveStage(bead.status);
  const testResults = options?.testResults ?? (await collectTestResults(options?.testCommand));

  const status: PipelineStatus = {
    bead,
    convoy,
    stage,
    testResults,
    tokenUsage: options?.tokenUsage ?? null,
    startedAt,
    elapsedMs: Date.now() - startedAt,
  };

  return renderEmbed(status);
}

/**
 * Render a PipelineStatus into a Discord-compatible embed object.
 * Can be used directly if you already have the status data.
 */
export function renderEmbed(status: PipelineStatus): StatusEmbed {
  const { stage, bead, testResults, tokenUsage, convoy, elapsedMs } = status;
  const config = STAGE_CONFIG[stage];

  const fields: EmbedField[] = [];

  // Stage field
  fields.push({
    name: "Stage",
    value: `${config.emoji} ${capitalize(stage)}`,
    inline: true,
  });

  // Priority field
  fields.push({
    name: "Priority",
    value: priorityLabel(bead.priority),
    inline: true,
  });

  // Elapsed time
  fields.push({
    name: "Elapsed",
    value: formatDuration(elapsedMs),
    inline: true,
  });

  // Test results
  if (testResults) {
    const icon = testResults.passed ? "\u{2705}" : "\u{274C}";
    let value = `${icon} ${testResults.passed ? "Passing" : "Failing"}`;
    if (testResults.total != null) {
      value += ` (${testResults.pass ?? 0}/${testResults.total})`;
    }
    fields.push({ name: "Tests", value, inline: true });
  }

  // Token usage
  if (tokenUsage) {
    fields.push({
      name: "Tokens",
      value: formatTokens(tokenUsage),
      inline: true,
    });
  }

  // Assignee
  if (bead.assignee) {
    fields.push({
      name: "Assignee",
      value: bead.assignee,
      inline: true,
    });
  }

  // Convoy members (if active)
  if (convoy && convoy.members.length > 0) {
    fields.push({
      name: "Convoy",
      value: formatConvoy(convoy),
      inline: false,
    });
  }

  return {
    title: `${config.emoji} ${bead.title}`,
    description: `\`${bead.id}\` \u2014 ${bead.issueType}`,
    color: config.color,
    fields,
    footer: { text: `bca pipeline \u2022 ${bead.id}` },
    timestamp: new Date().toISOString(),
  };
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function priorityLabel(p: number): string {
  const labels = [
    "\u{1F534} Critical",
    "\u{1F7E0} High",
    "\u{1F7E1} Medium",
    "\u{1F535} Low",
    "\u{26AA} Backlog",
  ];
  return labels[p] ?? `P${p}`;
}

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remaining = seconds % 60;
  if (minutes < 60) return `${minutes}m ${remaining}s`;
  const hours = Math.floor(minutes / 60);
  const remainingMin = minutes % 60;
  return `${hours}h ${remainingMin}m`;
}

function formatTokens(usage: TokenUsage): string {
  const fmt = (n: number) =>
    n >= 1_000_000
      ? `${(n / 1_000_000).toFixed(1)}M`
      : n >= 1_000
        ? `${(n / 1_000).toFixed(1)}K`
        : String(n);
  return `${fmt(usage.inputTokens)} in / ${fmt(usage.outputTokens)} out`;
}

function formatConvoy(convoy: ConvoyStatus): string {
  const lines = convoy.members.slice(0, 5).map((m) => {
    const icon =
      m.status === "closed" || m.status === "complete"
        ? "\u{2705}"
        : m.status === "failed"
          ? "\u{274C}"
          : "\u{1F7E1}";
    return `${icon} \`${m.id}\` ${m.title}`;
  });
  if (convoy.members.length > 5) {
    lines.push(`... and ${convoy.members.length - 5} more`);
  }
  return lines.join("\n");
}
