const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('ranks')
    .setDescription('List all ranks'),
  async execute(interaction, db) {
    db.all(`SELECT * FROM ranks WHERE guild_id = ?`, [interaction.guildId], (err, rows) => {
      if (err) return interaction.reply('Error fetching ranks!');
      const sortedRows = rows.sort((a, b) => a.start_elo - b.start_elo);
      const rankList = sortedRows.length > 0
        ? sortedRows.map(row => `<@&${row.role_id}> ST: ${row.start_elo} W:(+${row.win_elo}) L:(-${row.loss_elo}) MVP:(+${row.mvp_elo})`).join('\n')
        : 'No ranks defined.';
      const embed = new EmbedBuilder()
        .setTitle('Rank List')
        .setDescription(rankList)
        .setColor('#0099ff')
        .setFooter({ text: `Total Ranks: ${sortedRows.length}` })
        .setTimestamp();
      interaction.reply({ embeds: [embed] });
    });
  },
};