import {
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type AutocompleteInteraction,
  EmbedBuilder,
} from "discord.js";
import { loadProjectRegistry, getProject, type ProjectRegistry } from "../project";
import { buildStatusEmbed } from "../status/embed";

const WORK_TYPES = [
  { name: "Feature", value: "feature" },
  { name: "Bugfix", value: "bugfix" },
  { name: "Task", value: "task" },
  { name: "Chore", value: "chore" },
] as const;

export const workCommand = new SlashCommandBuilder()
  .setName("work")
  .setDescription("Dispatch a task to a polecat worker")
  .addStringOption((opt) =>
    opt
      .setName("type")
      .setDescription("Type of work")
      .setRequired(true)
      .addChoices(...WORK_TYPES),
  )
  .addStringOption((opt) =>
    opt
      .setName("project")
      .setDescription("Target project from registry")
      .setRequired(true)
      .setAutocomplete(true),
  )
  .addStringOption((opt) =>
    opt
      .setName("description")
      .setDescription("What needs to be done")
      .setRequired(true),
  );

let registryCache: { registry: ProjectRegistry; loadedAt: number } | null = null;
const CACHE_TTL_MS = 60_000;

async function getRegistry(): Promise<ProjectRegistry> {
  const now = Date.now();
  if (registryCache && now - registryCache.loadedAt < CACHE_TTL_MS) {
    return registryCache.registry;
  }
  const registry = await loadProjectRegistry();
  registryCache = { registry, loadedAt: now };
  return registry;
}

export async function handleWorkAutocomplete(
  interaction: AutocompleteInteraction,
): Promise<void> {
  const focused = interaction.options.getFocused();
  try {
    const registry = await getRegistry();
    const names = Object.keys(registry.projects);
    const filtered = names
      .filter((name) => name.toLowerCase().includes(focused.toLowerCase()))
      .slice(0, 25);
    await interaction.respond(
      filtered.map((name) => {
        const desc = registry.projects[name].description;
        return { name: desc ? `${name} — ${desc}` : name, value: name };
      }),
    );
  } catch {
    await interaction.respond([]);
  }
}

async function createIssue(
  type: string,
  description: string,
  projectName: string,
): Promise<string> {
  const bdType = type === "bugfix" ? "bug" : type === "feature" ? "feature" : "task";
  const proc = Bun.spawn(
    [
      "bd", "create", "--json",
      "-t", bdType,
      `[${projectName}] ${description}`,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const stdout = await new Response(proc.stdout).text();
  await proc.exited;

  if (proc.exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`bd create failed (exit ${proc.exitCode}): ${stderr}`);
  }

  const parsed = JSON.parse(stdout);
  const id = Array.isArray(parsed) ? parsed[0]?.id : parsed?.id;
  if (!id) throw new Error(`Failed to parse issue ID from bd output: ${stdout}`);
  return id;
}

async function createConvoyAndSling(
  issueId: string,
  projectName: string,
): Promise<string> {
  // Create convoy for this issue
  const convoyProc = Bun.spawn(
    ["gt", "convoy", "create", issueId, "--json"],
    { stdout: "pipe", stderr: "pipe" },
  );
  const convoyStdout = await new Response(convoyProc.stdout).text();
  await convoyProc.exited;

  if (convoyProc.exitCode !== 0) {
    const stderr = await new Response(convoyProc.stderr).text();
    throw new Error(`gt convoy create failed (exit ${convoyProc.exitCode}): ${stderr}`);
  }

  // Sling issue to a polecat
  const slingProc = Bun.spawn(
    ["gt", "sling", issueId],
    { stdout: "pipe", stderr: "pipe" },
  );
  await slingProc.exited;

  if (slingProc.exitCode !== 0) {
    const stderr = await new Response(slingProc.stderr).text();
    throw new Error(`gt sling failed (exit ${slingProc.exitCode}): ${stderr}`);
  }

  return convoyStdout.trim();
}

function statusEmbedToDiscord(embed: {
  title: string;
  description?: string;
  color: number;
  fields: Array<{ name: string; value: string; inline?: boolean }>;
  footer?: { text: string };
  timestamp?: string;
}): EmbedBuilder {
  const builder = new EmbedBuilder()
    .setTitle(embed.title)
    .setColor(embed.color);
  if (embed.description) builder.setDescription(embed.description);
  for (const field of embed.fields) {
    builder.addFields({ name: field.name, value: field.value, inline: field.inline });
  }
  if (embed.footer) builder.setFooter({ text: embed.footer.text });
  if (embed.timestamp) builder.setTimestamp(new Date(embed.timestamp));
  return builder;
}

async function pollForCompletion(
  issueId: string,
  reply: { edit: (opts: { embeds: EmbedBuilder[] }) => Promise<unknown> },
  startedAt: number,
): Promise<void> {
  const MAX_POLL_MS = 30 * 60 * 1000; // 30 minutes
  const POLL_INTERVAL_MS = 15_000;

  const deadline = Date.now() + MAX_POLL_MS;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));

    try {
      const embed = await buildStatusEmbed(issueId, { startedAt });
      const discordEmbed = statusEmbedToDiscord(embed);
      await reply.edit({ embeds: [discordEmbed] });

      // Check if pipeline is done
      const stage = embed.fields.find((f) => f.name === "Stage")?.value?.toLowerCase();
      if (stage?.includes("complete") || stage?.includes("failed")) {
        // Try to find PR URL on completion
        if (stage?.includes("complete")) {
          const prUrl = await findPrUrl(issueId);
          if (prUrl) {
            discordEmbed.addFields({ name: "Pull Request", value: prUrl });
            await reply.edit({ embeds: [discordEmbed] });
          }
        }
        return;
      }
    } catch {
      // Transient error — continue polling
    }
  }
}

async function findPrUrl(issueId: string): Promise<string | null> {
  // Check bd show for PR link in notes/metadata
  const proc = Bun.spawn(
    ["bd", "show", issueId, "--json"],
    { stdout: "pipe", stderr: "pipe" },
  );
  const stdout = await new Response(proc.stdout).text();
  await proc.exited;

  if (proc.exitCode === 0) {
    try {
      const parsed = JSON.parse(stdout);
      const bead = Array.isArray(parsed) ? parsed[0] : parsed;
      // Look for PR URL in notes or metadata
      const text = JSON.stringify(bead);
      const match = text.match(/https:\/\/github\.com\/[^\s"]+\/pull\/\d+/);
      if (match) return match[0];
    } catch {
      // ignore
    }
  }
  return null;
}

export async function handleWorkCommand(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const type = interaction.options.getString("type", true);
  const projectName = interaction.options.getString("project", true);
  const description = interaction.options.getString("description", true);

  // Validate project exists
  let registry: ProjectRegistry;
  try {
    registry = await getRegistry();
    getProject(registry, projectName);
  } catch {
    await interaction.reply({
      content: `Unknown project \`${projectName}\`. Check your projects.yaml registry.`,
      ephemeral: true,
    });
    return;
  }

  await interaction.deferReply();

  const startedAt = Date.now();

  try {
    // 1. Create bd issue
    const issueId = await createIssue(type, description, projectName);

    // 2. Create convoy and sling to polecat
    await createConvoyAndSling(issueId, projectName);

    // 3. Build initial status embed and reply
    const embed = await buildStatusEmbed(issueId, { startedAt });
    const discordEmbed = statusEmbedToDiscord(embed);
    const reply = await interaction.editReply({ embeds: [discordEmbed] });

    // 4. Poll for completion in background — update embed as status changes
    pollForCompletion(issueId, reply, startedAt).catch(() => {
      // Background polling failed — user can check manually
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await interaction.editReply({ content: `Failed to dispatch work: ${msg}` });
  }
}
