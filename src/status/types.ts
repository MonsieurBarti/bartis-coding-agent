/**
 * Status module types.
 *
 * Represents pipeline status data collected from bd and gt commands.
 * All types are plain objects — no discord.js dependency here.
 */

/** Status of an individual bead/issue. */
export interface BeadStatus {
  id: string;
  title: string;
  status: string;
  priority: number;
  issueType: string;
  assignee?: string;
  owner?: string;
  createdAt: string;
  updatedAt: string;
}

/** A single convoy member's status. */
export interface ConvoyMember {
  id: string;
  title: string;
  status: string;
  assignee?: string;
}

/** Convoy-level pipeline status from gt convoy status. */
export interface ConvoyStatus {
  name: string;
  status: string;
  members: ConvoyMember[];
  createdAt?: string;
}

/** Test result summary. */
export interface TestResults {
  passed: boolean;
  summary: string;
  /** Total tests run */
  total?: number;
  /** Tests that passed */
  pass?: number;
  /** Tests that failed */
  fail?: number;
}

/** Token usage for a pipeline run. */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

/** Aggregated pipeline status for embed rendering. */
export interface PipelineStatus {
  bead: BeadStatus;
  convoy: ConvoyStatus | null;
  stage: PipelineStage;
  testResults: TestResults | null;
  tokenUsage: TokenUsage | null;
  startedAt: number;
  elapsedMs: number;
}

/** Pipeline stage identifiers. */
export type PipelineStage =
  | "queued"
  | "designing"
  | "implementing"
  | "testing"
  | "reviewing"
  | "merging"
  | "complete"
  | "failed"
  | "unknown";

/** Discord embed field (matches discord.js APIEmbedField). */
export interface EmbedField {
  name: string;
  value: string;
  inline?: boolean;
}

/** Discord embed data (matches discord.js APIEmbed / EmbedBuilder input). */
export interface StatusEmbed {
  title: string;
  description?: string;
  color: number;
  fields: EmbedField[];
  footer?: { text: string };
  timestamp?: string;
}
