const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('score')
    .setDescription('Score a match (Mods only)')
    .addIntegerOption(option =>
      option.setName('match_id')
        .setDescription('The match number to score')
        .setRequired(true)
    )
    .addIntegerOption(option =>
      option.setName('winner_team')
        .setDescription('The winning team number (1 or 2)')
        .setRequired(true)
    )
    .addUserOption(option =>
      option.setName('mvp1')
        .setDescription('First MVP (optional)')
        .setRequired(false)
    )
    .addUserOption(option =>
      option.setName('mvp2')
        .setDescription('Second MVP (optional)')
        .setRequired(false)
    ),
  async execute(interaction, db) {
    const matchId = interaction.options.getInteger('match_id');
    const winnerTeam = interaction.options.getInteger('winner_team');
    const mvp1 = interaction.options.getUser('mvp1');
    const mvp2 = interaction.options.getUser('mvp2');

    if (winnerTeam !== 1 && winnerTeam !== 2) {
      return interaction.reply('Winner team must be 1 or 2!');
    }

    db.get(`SELECT ct_team, tr_team, scored FROM matches WHERE match_number = ? AND guild_id = ?`, [matchId, interaction.guildId], async (err, row) => {
      if (err || !row) return interaction.reply(`Match #${matchId} not found!`);
      if (row.scored) return interaction.reply(`Match #${matchId} has already been scored!`);

      const ctTeam = row.ct_team.split(',');
      const trTeam = row.tr_team.split(',');
      const winningTeam = winnerTeam === 1 ? ctTeam : trTeam;
      const losingTeam = winnerTeam === 1 ? trTeam : ctTeam;

      const eloChanges = [];
      for (const userId of winningTeam) {
        const winElo = 10; // Example value, replace with your logic
        const { oldElo, newElo, name } = await updatePlayerEloAndRank(db, interaction.guild, userId, winElo, userId === mvp1?.id || userId === mvp2?.id, 0);
        eloChanges.push(`[${oldElo}] -> [${newElo}] ${name}`);
      }
      for (const userId of losingTeam) {
        const lossElo = -5; // Example value, replace with your logic
        const { oldElo, newElo, name } = await updatePlayerEloAndRank(db, interaction.guild, userId, lossElo, false, 0);
        eloChanges.push(`[${oldElo}] -> [${newElo}] ${name}`);
      }

      db.run(`UPDATE matches SET scored = 1, winner_team = ?, mvp1 = ?, mvp2 = ? WHERE match_number = ? AND guild_id = ?`,
        [winnerTeam, mvp1?.id, mvp2?.id, matchId, interaction.guildId]);

      const embed = new EmbedBuilder()
        .setTitle(`Match #${matchId} Results`)
        .setDescription(eloChanges.join('\n'))
        .setColor('#00ff00')
        .setFooter({ text: `Match #${matchId} has been scored` });
      interaction.reply({ embeds: [embed] });
    });
  },
};