const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('stats')
    .setDescription('Show player stats')
    .addUserOption(option =>
      option.setName('user')
        .setDescription('The user to check stats for (defaults to you)')
        .setRequired(false)
    ),
  async execute(interaction, db) {
    const targetUser = interaction.options.getUser('user') || interaction.user;
    const userId = targetUser.id;

    db.get(`SELECT * FROM players WHERE user_id = ? AND guild_id = ?`, [userId, interaction.guildId], (err, row) => {
      if (err) return interaction.reply('Error fetching player stats!');
      if (!row) return interaction.reply(`No stats found for <@${userId}>.`);

      const embed = new EmbedBuilder()
        .setTitle(`${row.name}'s Stats`)
        .setDescription(`Elo: ${row.elo}\nWins: ${row.wins}\nLosses: ${row.losses}\nMVPs: ${row.mvps}`)
        .setColor('#0099ff')
        .setFooter({ text: `Player ID: ${userId}` })
        .setTimestamp();
      interaction.reply({ embeds: [embed] });
    });
  },
};