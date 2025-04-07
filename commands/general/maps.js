const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('maps')
    .setDescription('List all maps in the database'),
  async execute(interaction, db) {
    db.all(`SELECT map_name FROM maps WHERE guild_id = ?`, [interaction.guildId], (err, rows) => {
      if (err) return interaction.reply('Error fetching maps!');
      const mapList = rows.map(row => row.map_name).join('\n') || 'No maps found.';
      const embed = new EmbedBuilder()
        .setTitle('Map List')
        .setDescription(mapList)
        .setColor('#0099ff')
        .setFooter({ text: `Total Maps: ${rows.length}` })
        .setTimestamp();
      interaction.reply({ embeds: [embed] });
    });
  },
};