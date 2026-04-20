require("dotenv").config();
const fs = require("node:fs");
const path = require("node:path");
const {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  PermissionFlagsBits,
  REST,
  Routes,
  SlashCommandBuilder,
} = require("discord.js");

const REQUIRED_ENV = ["TOKEN", "CLIENT_ID"];
const missingEnv = REQUIRED_ENV.filter((key) => !process.env[key]);

if (missingEnv.length > 0) {
  console.error(
    `Missing environment variables: ${missingEnv.join(", ")}. Check your .env file.`
  );
  process.exit(1);
}

const DEFAULT_CONFIG = {
  staffRoleId: process.env.STAFF_ROLE_ID || "",
  ticketCategoryId: "",
  logsChannelId: "",
  ticketPrefix: "ticket-",
};

const DEFAULT_STATS = {
  closedCount: 0,
  firstResponseCount: 0,
  totalFirstResponseMs: 0,
};

const DATA_DIR = path.join(__dirname, "data");
const CONFIG_FILE_PATH = path.join(DATA_DIR, "guild-config.json");
const STATS_FILE_PATH = path.join(DATA_DIR, "ticket-stats.json");

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

function ensureJsonFile(filePath, fallbackObject) {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, JSON.stringify(fallbackObject, null, 2), "utf8");
  }
}

function readJson(filePath, fallbackObject) {
  ensureJsonFile(filePath, fallbackObject);
  const raw = fs.readFileSync(filePath, "utf8");
  try {
    return JSON.parse(raw);
  } catch (error) {
    console.error(`Failed to parse ${path.basename(filePath)}. Resetting file.`, error);
    fs.writeFileSync(filePath, JSON.stringify(fallbackObject, null, 2), "utf8");
    return JSON.parse(JSON.stringify(fallbackObject));
  }
}

function writeJson(filePath, content) {
  fs.writeFileSync(filePath, JSON.stringify(content, null, 2), "utf8");
}

function loadConfigs() {
  return readJson(CONFIG_FILE_PATH, {});
}

function saveConfigs(configs) {
  writeJson(CONFIG_FILE_PATH, configs);
}

function getGuildConfig(guildId) {
  const configs = loadConfigs();
  return { ...DEFAULT_CONFIG, ...(configs[guildId] || {}) };
}

function setGuildConfig(guildId, patch) {
  const configs = loadConfigs();
  const next = { ...DEFAULT_CONFIG, ...(configs[guildId] || {}), ...patch };
  configs[guildId] = next;
  saveConfigs(configs);
  return next;
}

function loadStats() {
  return readJson(STATS_FILE_PATH, {});
}

function saveStats(stats) {
  writeJson(STATS_FILE_PATH, stats);
}

function getGuildStats(guildId) {
  const allStats = loadStats();
  return { ...DEFAULT_STATS, ...(allStats[guildId] || {}) };
}

function updateGuildStats(guildId, patch) {
  const allStats = loadStats();
  const current = { ...DEFAULT_STATS, ...(allStats[guildId] || {}) };
  const next = { ...current, ...patch };
  allStats[guildId] = next;
  saveStats(allStats);
  return next;
}

function recordClosedTicket(guildId, firstResponseMs) {
  const stats = getGuildStats(guildId);
  const next = {
    closedCount: stats.closedCount + 1,
    firstResponseCount: stats.firstResponseCount,
    totalFirstResponseMs: stats.totalFirstResponseMs,
  };

  if (typeof firstResponseMs === "number" && Number.isFinite(firstResponseMs) && firstResponseMs >= 0) {
    next.firstResponseCount += 1;
    next.totalFirstResponseMs += firstResponseMs;
  }

  return updateGuildStats(guildId, next);
}

function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "n/a";
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const remSeconds = seconds % 60;
  if (minutes === 0) return `${remSeconds}s`;
  const hours = Math.floor(minutes / 60);
  const remMinutes = minutes % 60;
  if (hours === 0) return `${minutes}m ${remSeconds}s`;
  return `${hours}h ${remMinutes}m ${remSeconds}s`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

const commands = [
  new SlashCommandBuilder()
    .setName("setup")
    .setDescription("Initialise le bot ticket avec un assistant interactif.")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder()
    .setName("panel")
    .setDescription("Envoie le panneau de creation de ticket ici.")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder().setName("new").setDescription("Cree un nouveau ticket support."),
  new SlashCommandBuilder()
    .setName("close")
    .setDescription("Ferme le ticket courant et sauvegarde le transcript HTML.")
    .addStringOption((option) =>
      option.setName("reason").setDescription("Raison optionnelle de fermeture").setRequired(false)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels),
  new SlashCommandBuilder()
    .setName("add")
    .setDescription("Ajoute un utilisateur a ce ticket.")
    .addUserOption((option) =>
      option.setName("user").setDescription("User to add").setRequired(true)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels),
  new SlashCommandBuilder()
    .setName("remove")
    .setDescription("Retire un utilisateur de ce ticket.")
    .addUserOption((option) =>
      option.setName("user").setDescription("User to remove").setRequired(true)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels),
  new SlashCommandBuilder()
    .setName("transcript")
    .setDescription("Genere et envoie en DM le transcript HTML du ticket.")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels),
  new SlashCommandBuilder()
    .setName("stats")
    .setDescription("Affiche les statistiques ticket du serveur.")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels),
  new SlashCommandBuilder()
    .setName("reload")
    .setDescription("Recharge la configuration serveur depuis le disque.")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
].map((command) => command.toJSON());

async function registerCommands() {
  const rest = new REST({ version: "10" }).setToken(process.env.TOKEN);
  if (process.env.GUILD_ID) {
    await rest.put(
      Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID),
      { body: commands }
    );
    console.log(`Guild commands registered for ${process.env.GUILD_ID}.`);
    return;
  }

  await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), { body: commands });
  console.log("Global commands registered.");
}

async function ensureLogsChannel(guild, config) {
  if (config.logsChannelId) {
    const logsById = guild.channels.cache.get(config.logsChannelId);
    if (logsById && logsById.type === ChannelType.GuildText) return logsById;
  }

  const created = await guild.channels.create({
    name: "ticket-logs",
    type: ChannelType.GuildText,
  });

  setGuildConfig(guild.id, { logsChannelId: created.id });
  return created;
}

async function ensureTicketCategory(guild, config) {
  if (config.ticketCategoryId) {
    const categoryById = guild.channels.cache.get(config.ticketCategoryId);
    if (categoryById && categoryById.type === ChannelType.GuildCategory) return categoryById;
  }

  const created = await guild.channels.create({
    name: "Support Tickets",
    type: ChannelType.GuildCategory,
  });

  setGuildConfig(guild.id, { ticketCategoryId: created.id });
  return created;
}

async function ensureStaffRole(guild, config) {
  if (config.staffRoleId) {
    const roleById = guild.roles.cache.get(config.staffRoleId);
    if (roleById) return roleById;
  }

  const existingByName = guild.roles.cache.find(
    (role) => role.name.toLowerCase() === "ticket staff"
  );
  if (existingByName) {
    setGuildConfig(guild.id, { staffRoleId: existingByName.id });
    return existingByName;
  }

  const created = await guild.roles.create({
    name: "Ticket Staff",
    permissions: [
      PermissionFlagsBits.ViewChannel,
      PermissionFlagsBits.SendMessages,
      PermissionFlagsBits.ReadMessageHistory,
      PermissionFlagsBits.ManageChannels,
    ],
    reason: "Ticket setup wizard",
  });

  setGuildConfig(guild.id, { staffRoleId: created.id });
  return created;
}

function isTicketChannel(channel, config) {
  return (
    channel &&
    channel.type === ChannelType.GuildText &&
    channel.name.startsWith(config.ticketPrefix || DEFAULT_CONFIG.ticketPrefix)
  );
}

function extractTicketOwnerId(channelTopic) {
  if (!channelTopic) return null;
  const match = channelTopic.match(/owner:(\d{6,})/);
  return match ? match[1] : null;
}

async function fetchMessagesForTranscript(channel) {
  const allMessages = [];
  let lastId;

  while (true) {
    const options = { limit: 100 };
    if (lastId) options.before = lastId;

    const batch = await channel.messages.fetch(options);
    if (batch.size === 0) break;

    allMessages.push(...batch.values());
    lastId = batch.last().id;
  }

  return allMessages.reverse();
}

function buildTranscriptHtml({ guildName, channelName, closedByTag, closedById, reason, messages }) {
  const rows = messages
    .map((message) => {
      const timestamp = new Date(message.createdTimestamp).toISOString();
      const author = `${message.author.tag} (${message.author.id})`;
      const content = message.content || "[no text content]";
      return `<tr><td>${escapeHtml(timestamp)}</td><td>${escapeHtml(author)}</td><td>${escapeHtml(
        content
      )}</td></tr>`;
    })
    .join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Ticket Transcript - ${escapeHtml(channelName)}</title>
  <style>
    body { font-family: Arial, sans-serif; margin: 24px; color: #111827; background: #f9fafb; }
    h1 { margin: 0 0 6px 0; font-size: 22px; }
    .meta { margin: 0 0 20px 0; color: #4b5563; }
    table { border-collapse: collapse; width: 100%; background: white; }
    th, td { border: 1px solid #e5e7eb; padding: 8px; text-align: left; vertical-align: top; }
    th { background: #f3f4f6; }
    td:last-child { white-space: pre-wrap; word-break: break-word; }
  </style>
</head>
<body>
  <h1>Ticket Transcript</h1>
  <p class="meta">
    Guild: ${escapeHtml(guildName)}<br/>
    Channel: ${escapeHtml(channelName)}<br/>
    Ferme par: ${escapeHtml(`${closedByTag} (${closedById})`)}<br/>
    Raison: ${escapeHtml(reason || "Aucune raison fournie")}
  </p>
  <table>
    <thead>
      <tr><th>Timestamp (UTC)</th><th>Author</th><th>Message</th></tr>
    </thead>
    <tbody>
      ${rows || "<tr><td colspan=\"3\">No messages found.</td></tr>"}
    </tbody>
  </table>
</body>
</html>`;
}

async function computeFirstResponseMs(messages, staffRoleId, ownerId, guild) {
  if (!staffRoleId) return null;
  const createdAt = messages[0] ? messages[0].createdTimestamp : null;
  if (!createdAt) return null;

  for (const message of messages) {
    if (!message.author || message.author.bot) continue;
    if (message.author.id === ownerId) continue;

    try {
      const member = await guild.members.fetch(message.author.id);
      if (member.roles.cache.has(staffRoleId)) {
        return message.createdTimestamp - createdAt;
      }
    } catch (error) {
      console.error("Failed to resolve message author for stats:", error);
    }
  }

  return null;
}

async function sendTicketPanel(channel) {
  const embed = new EmbedBuilder()
    .setTitle("Tickets Support")
    .setDescription("Clique sur le bouton ci-dessous pour creer un ticket prive.")
    .setColor(0x5865f2);

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("ticket-create").setLabel("Creer un ticket").setStyle(ButtonStyle.Primary)
  );

  await channel.send({ embeds: [embed], components: [row] });
}

function sanitizeChannelSlug(input) {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

async function createTicketForUser(guild, user, sourceChannel) {
  const config = getGuildConfig(guild.id);
  const ticketPrefix = config.ticketPrefix || DEFAULT_CONFIG.ticketPrefix;
  const ownerId = user.id;

  if (!config.staffRoleId || !guild.roles.cache.has(config.staffRoleId)) {
    throw new Error("Le role staff n'est pas configure. Lance /setup d'abord.");
  }

  const existing = guild.channels.cache.find(
    (channel) =>
      isTicketChannel(channel, config) &&
      channel.topic &&
      channel.topic.includes(`owner:${ownerId}`)
  );

  if (existing) {
    return { alreadyExists: true, channel: existing };
  }

  const category = await ensureTicketCategory(guild, config);
  const slug = sanitizeChannelSlug(`${ticketPrefix}${user.username || user.id}`) || `${ticketPrefix}ticket`;
  const channelName = slug.startsWith(ticketPrefix) ? slug : `${ticketPrefix}${slug}`.slice(0, 60);

  const ticketChannel = await guild.channels.create({
    name: channelName,
    type: ChannelType.GuildText,
    parent: category.id,
    topic: `owner:${ownerId}`,
    permissionOverwrites: [
      {
        id: guild.roles.everyone.id,
        deny: [PermissionFlagsBits.ViewChannel],
      },
      {
        id: ownerId,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory,
        ],
      },
      {
        id: config.staffRoleId,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory,
          PermissionFlagsBits.ManageChannels,
        ],
      },
    ],
  });

  const closeRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("ticket-close")
      .setLabel("Fermer le ticket")
      .setStyle(ButtonStyle.Danger)
  );

  await ticketChannel.send({
    content:
      `Bienvenue ${user}. Un membre du staff va te repondre rapidement.\n` +
      "Utilise `/close` ou le bouton ci-dessous pour fermer le ticket.",
    components: [closeRow],
  });

  if (sourceChannel && sourceChannel.id !== ticketChannel.id) {
    await sourceChannel.send(`${user}, ton ticket a ete cree: ${ticketChannel}`);
  }

  return { alreadyExists: false, channel: ticketChannel };
}

async function closeTicketChannel(interaction, reason) {
  const guild = interaction.guild;
  const guildConfig = getGuildConfig(guild.id);

  if (!isTicketChannel(interaction.channel, guildConfig)) {
    if (interaction.deferred || interaction.replied) {
      await interaction.followUp({ content: "Utilise cette action uniquement dans un salon ticket.", ephemeral: true });
    } else {
      await interaction.reply({ content: "Utilise cette action uniquement dans un salon ticket.", ephemeral: true });
    }
    return;
  }

  const messages = await fetchMessagesForTranscript(interaction.channel);
  const ownerId = extractTicketOwnerId(interaction.channel.topic);
  const firstResponseMs = await computeFirstResponseMs(messages, guildConfig.staffRoleId, ownerId, guild);

  const html = buildTranscriptHtml({
    guildName: guild.name,
    channelName: interaction.channel.name,
    closedByTag: interaction.user.tag,
    closedById: interaction.user.id,
    reason,
    messages,
  });

  const transcriptName = `${interaction.channel.name}-transcript.html`;
  const transcriptBuffer = Buffer.from(html, "utf8");
  const logs = await ensureLogsChannel(guild, guildConfig);

  await logs.send({
    content:
      `Ticket ferme: #${interaction.channel.name}\n` +
      `Ferme par: ${interaction.user.tag} (${interaction.user.id})\n` +
      `Raison: ${reason}\n` +
      `Premiere reponse: ${formatDuration(firstResponseMs)}`,
    files: [new AttachmentBuilder(transcriptBuffer, { name: transcriptName })],
  });

  recordClosedTicket(guild.id, firstResponseMs);

  if (interaction.deferred || interaction.replied) {
    await interaction.followUp({
      content: "Ticket ferme. Transcript sauvegarde dans les logs. Suppression du salon dans 5 secondes.",
      ephemeral: true,
    });
  } else {
    await interaction.reply({
      content: "Ticket ferme. Transcript sauvegarde dans les logs. Suppression du salon dans 5 secondes.",
      ephemeral: true,
    });
  }

  setTimeout(async () => {
    try {
      await interaction.channel.delete("Ticket ferme par le staff.");
    } catch (error) {
      console.error("Failed to delete ticket channel:", error);
    }
  }, 5000);
}

client.once(Events.ClientReady, () => {
  console.log(`Logged in as ${client.user.tag}`);
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      if (!interaction.guild) {
        await interaction.reply({ content: "Cette commande est utilisable uniquement sur un serveur.", ephemeral: true });
        return;
      }

      const guild = interaction.guild;
      const guildConfig = getGuildConfig(guild.id);

      if (interaction.commandName === "setup") {
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId("setup-run")
            .setLabel("Lancer le setup")
            .setStyle(ButtonStyle.Success)
        );

        await interaction.reply({
          content:
            "Le setup interactif est pret. Clique sur le bouton ci-dessous pour initialiser role staff, categorie, logs et panneau dans ce salon.",
          components: [row],
          ephemeral: true,
        });
        return;
      }

      if (interaction.commandName === "panel") {
        await sendTicketPanel(interaction.channel);
        await interaction.reply({ content: "Panneau ticket envoye.", ephemeral: true });
        return;
      }

      if (interaction.commandName === "new") {
        await interaction.deferReply({ ephemeral: true });
        const result = await createTicketForUser(guild, interaction.user, interaction.channel);
        if (result.alreadyExists) {
          await interaction.followUp({
            content: `Tu as deja un ticket ouvert: ${result.channel}`,
            ephemeral: true,
          });
          return;
        }

        await interaction.followUp({
          content: `Ticket cree: ${result.channel}`,
          ephemeral: true,
        });
        return;
      }

      if (interaction.commandName === "add") {
        if (!isTicketChannel(interaction.channel, guildConfig)) {
          await interaction.reply({ content: "Utilise cette commande uniquement dans un salon ticket.", ephemeral: true });
          return;
        }

        const user = interaction.options.getUser("user", true);
        await interaction.channel.permissionOverwrites.edit(user.id, {
          ViewChannel: true,
          SendMessages: true,
          ReadMessageHistory: true,
        });

        await interaction.reply({ content: `${user} a ete ajoute au ticket.` });
        return;
      }

      if (interaction.commandName === "remove") {
        if (!isTicketChannel(interaction.channel, guildConfig)) {
          await interaction.reply({ content: "Utilise cette commande uniquement dans un salon ticket.", ephemeral: true });
          return;
        }

        const user = interaction.options.getUser("user", true);
        await interaction.channel.permissionOverwrites.delete(user.id);
        await interaction.reply({ content: `${user} a ete retire du ticket.` });
        return;
      }

      if (interaction.commandName === "transcript") {
        if (!isTicketChannel(interaction.channel, guildConfig)) {
          await interaction.reply({ content: "Utilise cette commande uniquement dans un salon ticket.", ephemeral: true });
          return;
        }

        await interaction.deferReply({ ephemeral: true });
        const messages = await fetchMessagesForTranscript(interaction.channel);
        const html = buildTranscriptHtml({
          guildName: guild.name,
          channelName: interaction.channel.name,
          closedByTag: interaction.user.tag,
          closedById: interaction.user.id,
          reason: "Genere manuellement avec /transcript",
          messages,
        });

        const file = new AttachmentBuilder(Buffer.from(html, "utf8"), {
          name: `${interaction.channel.name}-transcript.html`,
        });

        try {
          await interaction.user.send({
            content: `Transcript pour #${interaction.channel.name}`,
            files: [file],
          });
          await interaction.followUp({
            content: "Transcript genere et envoye en DM.",
            ephemeral: true,
          });
        } catch (error) {
          await interaction.followUp({
            content: "Impossible d'envoyer le transcript en DM. Active les messages prives puis reessaie.",
            ephemeral: true,
          });
        }
        return;
      }

      if (interaction.commandName === "stats") {
        const stats = getGuildStats(guild.id);
        const openCount = guild.channels.cache.filter((channel) => isTicketChannel(channel, guildConfig)).size;
        const avgResponseMs =
          stats.firstResponseCount > 0 ? Math.round(stats.totalFirstResponseMs / stats.firstResponseCount) : null;

        const embed = new EmbedBuilder()
          .setTitle("Statistiques tickets")
          .setColor(0x2ecc71)
          .addFields(
            { name: "Tickets ouverts", value: String(openCount), inline: true },
            { name: "Tickets fermes", value: String(stats.closedCount), inline: true },
            { name: "Moyenne premiere reponse", value: formatDuration(avgResponseMs), inline: true }
          );

        await interaction.reply({ embeds: [embed], ephemeral: true });
        return;
      }

      if (interaction.commandName === "reload") {
        const config = getGuildConfig(guild.id);
        await interaction.reply({
          content:
            "Configuration rechargee depuis le disque.\n" +
            `staffRoleId: ${config.staffRoleId || "non defini"}\n` +
            `ticketCategoryId: ${config.ticketCategoryId || "non defini"}\n` +
            `logsChannelId: ${config.logsChannelId || "non defini"}\n` +
            `ticketPrefix: ${config.ticketPrefix || "ticket-"}`,
          ephemeral: true,
        });
        return;
      }

      if (interaction.commandName === "close") {
        const reason = interaction.options.getString("reason") || "Aucune raison fournie";
        await interaction.deferReply({ ephemeral: true });
        await closeTicketChannel(interaction, reason);
      }
    }

    if (interaction.isButton() && interaction.customId === "ticket-create") {
      if (!interaction.guild) {
        await interaction.reply({ content: "Cette action est utilisable uniquement sur un serveur.", ephemeral: true });
        return;
      }
      const result = await createTicketForUser(interaction.guild, interaction.user, interaction.channel);
      if (result.alreadyExists) {
        await interaction.reply({
          content: `Tu as deja un ticket ouvert: ${result.channel}`,
          ephemeral: true,
        });
        return;
      }

      await interaction.reply({
        content: `Ticket cree: ${result.channel}`,
        ephemeral: true,
      });
      return;
    }

    if (interaction.isButton() && interaction.customId === "ticket-close") {
      if (!interaction.guild) {
        await interaction.reply({ content: "Cette action est utilisable uniquement sur un serveur.", ephemeral: true });
        return;
      }
      if (!interaction.memberPermissions || !interaction.memberPermissions.has(PermissionFlagsBits.ManageChannels)) {
        await interaction.reply({
          content: "Seul le staff peut fermer un ticket avec ce bouton.",
          ephemeral: true,
        });
        return;
      }
      await interaction.deferReply({ ephemeral: true });
      await closeTicketChannel(interaction, "Ferme via bouton");
      return;
    }

    if (interaction.isButton() && interaction.customId === "setup-run") {
      if (!interaction.guild) {
        await interaction.reply({ content: "Cette action est utilisable uniquement sur un serveur.", ephemeral: true });
        return;
      }

      if (!interaction.memberPermissions || !interaction.memberPermissions.has(PermissionFlagsBits.Administrator)) {
        await interaction.reply({
          content: "Seuls les administrateurs peuvent lancer le setup.",
          ephemeral: true,
        });
        return;
      }

      await interaction.deferReply({ ephemeral: true });
      const guild = interaction.guild;
      let config = getGuildConfig(guild.id);
      const staffRole = await ensureStaffRole(guild, config);
      config = setGuildConfig(guild.id, { staffRoleId: staffRole.id });

      const category = await ensureTicketCategory(guild, config);
      const logs = await ensureLogsChannel(guild, config);
      setGuildConfig(guild.id, { ticketCategoryId: category.id, logsChannelId: logs.id });

      await sendTicketPanel(interaction.channel);

      await interaction.followUp({
        content:
          "Setup termine.\n" +
          `Staff role: <@&${staffRole.id}>\n` +
          `Categorie tickets: ${category}\n` +
          `Salon logs: ${logs}\n` +
          "Le panneau a ete envoye dans ce salon.",
        ephemeral: true,
      });
    }
  } catch (error) {
    console.error("Interaction error:", error);
    if (interaction.deferred || interaction.replied) {
      await interaction.followUp({
        content: "Une erreur est survenue pendant le traitement de cette action.",
        ephemeral: true,
      });
    } else {
      await interaction.reply({
        content: "Une erreur est survenue pendant le traitement de cette action.",
        ephemeral: true,
      });
    }
  }
});

async function main() {
  ensureJsonFile(CONFIG_FILE_PATH, {});
  ensureJsonFile(STATS_FILE_PATH, {});
  await registerCommands();
  await client.login(process.env.TOKEN);
}

main().catch((error) => {
  console.error("Startup error:", error);
  process.exit(1);
});
