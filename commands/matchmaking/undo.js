const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('undo')
    .setDescription('Undo scoring for a match (Mods only)')
    .addIntegerOption(option =>
      option.setName('match_id')
        .setDescription('The match number to undo')
        .setRequired(true)
    ),
  async execute(interaction, db) {
    if (!interaction.member.permissions.has('ManageChannels')) {
      return interaction.reply('Only moderators can use this command!');
    }

    const matchId = interaction.options.getInteger('match_id');
    db.get(`SELECT ct_team, tr_team, scored FROM matches WHERE match_number = ? AND guild_id = ?`, [matchId, interaction.guildId], async (err, row) => {
      if (err || !row) return interaction.reply(`Match #${matchId} not found!`);
      if (!row.scored) return interaction.reply(`Match #${matchId} has not been scored!`);

      const ctTeam = row.ct_team.split(',');
      const trTeam = row.tr_team.split(',');
      const allPlayers = [...ctTeam, ...trTeam];
      const eloChanges = [];

      for (const userId of allPlayers) {
        const playerData = await new Promise(resolve => {
          db.get(`SELECT elo, name FROM players WHERE user_id = ? AND guild_id = ?`, [userId, interaction.guildId], (err, row) => resolve(row));
        });
        if (!playerData) continue;

        const { elo, name } = playerData;
        db.run(`UPDATE players SET elo = ? WHERE user_id = ? AND guild_id = ?`, [elo, userId, interaction.guildId]);
        eloChanges.push(`${name}: Elo reset to ${elo}`);
      }

      db.run(`UPDATE matches SET scored = 0 WHERE match_number = ? AND guild_id = ?`, [matchId, interaction.guildId]);
      const embed = new EmbedBuilder()
        .setTitle(`Match #${matchId} Undo Results`)
        .setDescription(eloChanges.join('\n'))
        .setColor('#ff0000')
        .setFooter({ text: `Match #${matchId} has been unscored` });
      interaction.reply({ embeds: [embed] });
    });
  },
};