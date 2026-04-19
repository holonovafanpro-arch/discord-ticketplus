require("dotenv").config();
const fs = require("node:fs");
const path = require("node:path");
const {
  ActionRowBuilder,
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
const CONFIG_FILE_PATH = path.join(__dirname, "data", "guild-config.json");

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

function ensureConfigFile() {
  const directory = path.dirname(CONFIG_FILE_PATH);
  if (!fs.existsSync(directory)) {
    fs.mkdirSync(directory, { recursive: true });
  }
  if (!fs.existsSync(CONFIG_FILE_PATH)) {
    fs.writeFileSync(CONFIG_FILE_PATH, JSON.stringify({}, null, 2), "utf8");
  }
}

function loadConfigs() {
  ensureConfigFile();
  const raw = fs.readFileSync(CONFIG_FILE_PATH, "utf8");
  return JSON.parse(raw);
}

function saveConfigs(configs) {
  fs.writeFileSync(CONFIG_FILE_PATH, JSON.stringify(configs, null, 2), "utf8");
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

const commands = [
  new SlashCommandBuilder()
    .setName("setup-tickets")
    .setDescription("Send the ticket panel in this channel.")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder()
    .setName("config")
    .setDescription("Configure ticket system for this server.")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand((subcommand) =>
      subcommand
        .setName("set")
        .setDescription("Set one configuration value.")
        .addStringOption((option) =>
          option
            .setName("key")
            .setDescription("Config key")
            .setRequired(true)
            .addChoices(
              { name: "staff_role_id", value: "staffRoleId" },
              { name: "ticket_category_id", value: "ticketCategoryId" },
              { name: "logs_channel_id", value: "logsChannelId" },
              { name: "ticket_prefix", value: "ticketPrefix" }
            )
        )
        .addStringOption((option) =>
          option
            .setName("value")
            .setDescription("Value for the selected key")
            .setRequired(true)
        )
    )
    .addSubcommand((subcommand) =>
      subcommand.setName("view").setDescription("View current server configuration.")
    ),
  new SlashCommandBuilder()
    .setName("add")
    .setDescription("Add a user to this ticket.")
    .addUserOption((option) =>
      option.setName("user").setDescription("User to add").setRequired(true)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels),
  new SlashCommandBuilder()
    .setName("remove")
    .setDescription("Remove a user from this ticket.")
    .addUserOption((option) =>
      option.setName("user").setDescription("User to remove").setRequired(true)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels),
  new SlashCommandBuilder()
    .setName("claim")
    .setDescription("Claim this ticket.")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels),
  new SlashCommandBuilder()
    .setName("close")
    .setDescription("Close this ticket.")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels),
  new SlashCommandBuilder()
    .setName("transcript")
    .setDescription("Create a transcript text file for this ticket.")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels),
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

function isTicketChannel(channel, config) {
  return (
    channel &&
    channel.type === ChannelType.GuildText &&
    channel.name.startsWith(config.ticketPrefix || DEFAULT_CONFIG.ticketPrefix)
  );
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

function formatTranscript(messages) {
  return messages
    .map((message) => {
      const createdAt = new Date(message.createdTimestamp).toISOString();
      const author = `${message.author.tag} (${message.author.id})`;
      const content = message.content || "[no text content]";
      return `[${createdAt}] ${author}: ${content}`;
    })
    .join("\n");
}

client.once(Events.ClientReady, () => {
  console.log(`Logged in as ${client.user.tag}`);
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      const guildConfig = getGuildConfig(interaction.guild.id);

      if (interaction.commandName === "setup-tickets") {
        const embed = new EmbedBuilder()
          .setTitle("Support")
          .setDescription("Click the button below to create a private support ticket.")
          .setColor(0x5865f2);

        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId("ticket-create")
            .setLabel("Create Ticket")
            .setStyle(ButtonStyle.Primary)
        );

        await interaction.reply({
          content: "Ticket panel sent.",
          ephemeral: true,
        });

        await interaction.channel.send({ embeds: [embed], components: [row] });
        return;
      }

      if (interaction.commandName === "config") {
        const subcommand = interaction.options.getSubcommand();
        if (subcommand === "view") {
          const text =
            `staffRoleId: ${guildConfig.staffRoleId || "not set"}\n` +
            `ticketCategoryId: ${guildConfig.ticketCategoryId || "not set"}\n` +
            `logsChannelId: ${guildConfig.logsChannelId || "not set"}\n` +
            `ticketPrefix: ${guildConfig.ticketPrefix || "ticket-"}`;

          await interaction.reply({ content: `Current config:\n\`\`\`\n${text}\n\`\`\``, ephemeral: true });
          return;
        }

        const key = interaction.options.getString("key", true);
        const value = interaction.options.getString("value", true).trim();
        const nextConfig = setGuildConfig(interaction.guild.id, { [key]: value });

        await interaction.reply({
          content: `Config updated: \`${key}\` set.\nNew value: \`${nextConfig[key]}\``,
          ephemeral: true,
        });
        return;
      }

      if (interaction.commandName === "add") {
        if (!isTicketChannel(interaction.channel, guildConfig)) {
          await interaction.reply({ content: "Use this in a ticket channel only.", ephemeral: true });
          return;
        }

        const user = interaction.options.getUser("user", true);
        await interaction.channel.permissionOverwrites.edit(user.id, {
          ViewChannel: true,
          SendMessages: true,
          ReadMessageHistory: true,
        });

        await interaction.reply({ content: `${user} added to the ticket.` });
        return;
      }

      if (interaction.commandName === "remove") {
        if (!isTicketChannel(interaction.channel, guildConfig)) {
          await interaction.reply({ content: "Use this in a ticket channel only.", ephemeral: true });
          return;
        }

        const user = interaction.options.getUser("user", true);
        await interaction.channel.permissionOverwrites.delete(user.id);
        await interaction.reply({ content: `${user} removed from the ticket.` });
        return;
      }

      if (interaction.commandName === "claim") {
        if (!isTicketChannel(interaction.channel, guildConfig)) {
          await interaction.reply({ content: "Use this in a ticket channel only.", ephemeral: true });
          return;
        }

        await interaction.channel.send(`Ticket claimed by ${interaction.user}.`);
        await interaction.reply({ content: "Ticket claimed.", ephemeral: true });
        return;
      }

      if (interaction.commandName === "transcript") {
        if (!isTicketChannel(interaction.channel, guildConfig)) {
          await interaction.reply({ content: "Use this in a ticket channel only.", ephemeral: true });
          return;
        }

        await interaction.deferReply({ ephemeral: true });
        const messages = await fetchMessagesForTranscript(interaction.channel);
        const transcript = formatTranscript(messages);

        await interaction.followUp({
          content: "Transcript generated.",
          files: [
            {
              attachment: Buffer.from(transcript || "No messages found.", "utf8"),
              name: `${interaction.channel.name}-transcript.txt`,
            },
          ],
          ephemeral: true,
        });
        return;
      }

      if (interaction.commandName === "close") {
        if (!isTicketChannel(interaction.channel, guildConfig)) {
          await interaction.reply({ content: "Use this in a ticket channel only.", ephemeral: true });
          return;
        }

        await interaction.reply("Closing ticket in 3 seconds...");

        const logs = await ensureLogsChannel(interaction.guild, guildConfig);
        await logs.send(
          `Closed ticket: ${interaction.channel.name} by ${interaction.user.tag} (${interaction.user.id})`
        );

        setTimeout(async () => {
          await interaction.channel.delete("Ticket closed by staff.");
        }, 3000);
        return;
      }
    }

    if (interaction.isButton() && interaction.customId === "ticket-create") {
      const guild = interaction.guild;
      const guildConfig = getGuildConfig(guild.id);
      const userId = interaction.user.id;
      const staffRoleId = guildConfig.staffRoleId;
      const ticketPrefix = guildConfig.ticketPrefix || DEFAULT_CONFIG.ticketPrefix;

      if (!staffRoleId) {
        await interaction.reply({
          content: "Staff role is not configured. Use `/config set key:staff_role_id value:<ROLE_ID>`.",
          ephemeral: true,
        });
        return;
      }

      const channelName = `${ticketPrefix}${interaction.user.username}`
        .toLowerCase()
        .replace(/[^a-z0-9-]/g, "")
        .slice(0, 28);

      const existing = guild.channels.cache.find(
        (channel) =>
          isTicketChannel(channel, guildConfig) &&
          channel.topic &&
          channel.topic.includes(`owner:${userId}`)
      );

      if (existing) {
        await interaction.reply({
          content: `You already have an open ticket: ${existing}`,
          ephemeral: true,
        });
        return;
      }

      const category = await ensureTicketCategory(guild, guildConfig);
      const ticketChannel = await guild.channels.create({
        name: channelName,
        type: ChannelType.GuildText,
        parent: category.id,
        topic: `owner:${userId}`,
        permissionOverwrites: [
          {
            id: guild.roles.everyone.id,
            deny: [PermissionFlagsBits.ViewChannel],
          },
          {
            id: userId,
            allow: [
              PermissionFlagsBits.ViewChannel,
              PermissionFlagsBits.SendMessages,
              PermissionFlagsBits.ReadMessageHistory,
            ],
          },
          {
            id: staffRoleId,
            allow: [
              PermissionFlagsBits.ViewChannel,
              PermissionFlagsBits.SendMessages,
              PermissionFlagsBits.ReadMessageHistory,
              PermissionFlagsBits.ManageChannels,
            ],
          },
        ],
      });

      await ticketChannel.send(
        `Welcome ${interaction.user}. A staff member will assist you soon.\n` +
          "Use `/close` when your issue is resolved."
      );

      await interaction.reply({
        content: `Ticket created: ${ticketChannel}`,
        ephemeral: true,
      });
    }
  } catch (error) {
    console.error("Interaction error:", error);
    if (interaction.deferred || interaction.replied) {
      await interaction.followUp({
        content: "An error occurred while processing this action.",
        ephemeral: true,
      });
    } else {
      await interaction.reply({
        content: "An error occurred while processing this action.",
        ephemeral: true,
      });
    }
  }
});

async function main() {
  ensureConfigFile();
  await registerCommands();
  await client.login(process.env.TOKEN);
}

main().catch((error) => {
  console.error("Startup error:", error);
  process.exit(1);
});
