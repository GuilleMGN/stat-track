const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('add_queue')
    .setDescription('Add a queue channel (Mods only)')
    .addChannelOption(option =>
      option.setName('channel_id')
        .setDescription('The channel for matchmaking')
        .setRequired(true)
    )
    .addStringOption(option =>
      option.setName('title')
        .setDescription('Custom title for the queue embed')
        .setRequired(false)
    )
    .addIntegerOption(option =>
      option.setName('bonus')
        .setDescription('Bonus Elo for winners in this queue')
        .setRequired(false)
    ),
  async execute(interaction, db) {
    if (!interaction.member.permissions.has('ManageChannels')) {
      return interaction.reply('Only moderators can use this command!');
    }

    const channel = interaction.options.getChannel('channel_id');
    const title = interaction.options.getString('title') || 'Matchmaking Queue';
    const bonus = interaction.options.getInteger('bonus') || 0;

    if (channel.type !== 0) {
      return interaction.reply('Please select a text channel!');
    }

    try {
      await new Promise((resolve, reject) => {
        db.run(`INSERT OR IGNORE INTO queues (channel_id, guild_id, title) VALUES (?, ?, ?)`, [channel.id, interaction.guildId, title], err => {
          if (err) reject(err);
          else resolve();
        });
      });

      const embed = new EmbedBuilder()
        .setTitle(title)
        .setDescription('**Players:**\nNone\n\n**Count:** 0/10')
        .setColor('#0099ff')
        .setFooter({ text: 'Queue initialized' })
        .setTimestamp();

      const row = new ActionRowBuilder()
        .addComponents(
          new ButtonBuilder().setCustomId('join_queue').setLabel('Join').setStyle(ButtonStyle.Primary),
          new ButtonBuilder().setCustomId('leave_queue').setLabel('Leave').setStyle(ButtonStyle.Danger),
          new ButtonBuilder().setCustomId('clear_queue').setLabel('Clear').setStyle(ButtonStyle.Secondary)
        );

      const msg = await channel.send({ embeds: [embed], components: [row] });

      db.run(`INSERT OR REPLACE INTO settings (key, value, guild_id) VALUES (?, ?, ?)`, [`queue_message_${channel.id}`, msg.id, interaction.guildId]);
      db.run(`INSERT OR REPLACE INTO settings (key, value, guild_id) VALUES (?, ?, ?)`, [`queue_bonus_${channel.id}`, bonus, interaction.guildId]);

      interaction.reply(`Queue channel set to <#${channel.id}>!`);
    } catch (error) {
      interaction.reply('Error adding queue channel!');
      console.error('Add queue error:', error);
    }
  },
};