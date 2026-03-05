import {
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
  EmbedBuilder,
  SlashCommandBuilder,
} from "discord.js";
import {
  closeConvoyForIssue,
  createIssue,
  findPrUrl,
  linkIssueToConvoy,
  slingWork,
} from "../dispatch/convoy";
import { getProject, loadProjectRegistry, type ProjectRegistry } from "../project";
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
    opt.setName("title").setDescription("Short title for the task").setRequired(true),
  )
  .addStringOption((opt) =>
    opt
      .setName("description")
      .setDescription("Detailed description of what needs to be done")
      .setRequired(false),
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

export async function handleWorkAutocomplete(interaction: AutocompleteInteraction): Promise<void> {
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

function statusEmbedToDiscord(embed: {
  title: string;
  description?: string;
  color: number;
  fields: Array<{ name: string; value: string; inline?: boolean }>;
  footer?: { text: string };
  timestamp?: string;
}): EmbedBuilder {
  const builder = new EmbedBuilder().setTitle(embed.title).setColor(embed.color);
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
  const PR_RETRY_DELAY_MS = 10_000;
  const PR_MAX_RETRIES = 6; // up to 60s of retries

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
        // Close the convoy now that the issue is done
        await closeConvoyForIssue(issueId);

        if (stage?.includes("complete")) {
          // Retry PR lookup — the polecat may still be pushing/creating the PR
          for (let attempt = 0; attempt < PR_MAX_RETRIES; attempt++) {
            const prUrl = await findPrUrl(issueId);
            if (prUrl) {
              discordEmbed.addFields({ name: "Pull Request", value: prUrl });
              await reply.edit({ embeds: [discordEmbed] });
              break;
            }
            if (attempt < PR_MAX_RETRIES - 1) {
              await new Promise((r) => setTimeout(r, PR_RETRY_DELAY_MS));
            }
          }
        }
        return;
      }
    } catch {
      // Transient error — continue polling
    }
  }
}

export async function handleWorkCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  const type = interaction.options.getString("type", true);
  const projectName = interaction.options.getString("project", true);
  const title = interaction.options.getString("title", true);
  const description = interaction.options.getString("description") ?? undefined;

  // Validate project exists
  try {
    const registry = await getRegistry();
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
    const bdType = type === "bugfix" ? "bug" : type === "feature" ? "feature" : "task";
    const issueTitle = `[${projectName}] ${title}`;
    const issueId = await createIssue(issueTitle, bdType, description);

    // 2. Sling to polecat — gt sling auto-creates a convoy
    await slingWork(issueId, projectName);

    // 3. Link issue to the auto-created convoy
    await linkIssueToConvoy(issueId);

    // 4. Build initial status embed and reply
    const embed = await buildStatusEmbed(issueId, { startedAt });
    const discordEmbed = statusEmbedToDiscord(embed);
    const reply = await interaction.editReply({ embeds: [discordEmbed] });

    // 5. Poll for completion in background — update embed as status changes
    pollForCompletion(issueId, reply, startedAt).catch(() => {
      // Background polling failed — user can check manually
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await interaction.editReply({ content: `Failed to dispatch work: ${msg}` });
  }
}
