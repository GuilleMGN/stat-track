const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('queues')
    .setDescription('List all queue channels'),
  async execute(interaction, db) {
    db.all(`SELECT channel_id FROM queues WHERE guild_id = ?`, [interaction.guildId], (err, rows) => {
      if (err) return interaction.reply('Error fetching queues!');
      const queueList = rows.map(row => `<#${row.channel_id}>`).join('\n') || 'No queue channels set.';
      const embed = new EmbedBuilder()
        .setTitle('Queue Channels')
        .setDescription(queueList)
        .setColor('#0099ff')
        .setTimestamp();
      interaction.reply({ embeds: [embed] });
    });
  },
};