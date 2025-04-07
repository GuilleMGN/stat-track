const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('leaderboard')
    .setDescription('Displays the top 10 players by elo'),
  
  async execute(interaction, db) {
    try {
      await interaction.deferReply();

      const rows = await new Promise((resolve, reject) => {
        db.all(
          `SELECT name, elo FROM players WHERE guild_id = ? ORDER BY elo DESC LIMIT 10`,
          [interaction.guildId],
          (err, rows) => {
            if (err) return reject(err);
            resolve(rows);
          }
        );
      });
      
      const leaderboard = rows.length > 0
        ? rows.map((row, i) => `${i + 1}. ${row.elo} | ${row.name}`).join('\n')
        : 'No players registered yet.';

      const embed = new EmbedBuilder()
        .setTitle('🏆 Leaderboard - Top 10 Players')
        .setDescription(leaderboard)
        .setColor('#FFD700')
        .setFooter({ text: `Total Players: ${rows.length}` })
        .setTimestamp();

      await interaction.editReply({ embeds: [embed] });
      
    } catch (error) {
      console.error('Error in leaderboard command:', error);
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply({
          content: '❌ An error occurred while executing this command.'
        });
      } else {
        await interaction.reply({ content: '❌ An error occurred while executing this command.', flags: 64 });
      }
    }
  }
};