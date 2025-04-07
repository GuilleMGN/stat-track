const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('sub')
    .setDescription('Substitute a player in a match (Mods only)')
    .addIntegerOption(option =>
      option.setName('match_id')
        .setDescription('The match number')
        .setRequired(true)
    )
    .addUserOption(option =>
      option.setName('old_player')
        .setDescription('The player to replace')
        .setRequired(true)
    )
    .addUserOption(option =>
      option.setName('new_player')
        .setDescription('The new player')
        .setRequired(true)
    ),
  async execute(interaction, db) {
    const matchId = interaction.options.getInteger('match_id');
    const oldPlayer = interaction.options.getUser('old_player');
    const newPlayer = interaction.options.getUser('new_player');

    db.get(`SELECT ct_team, tr_team, map, scored FROM matches WHERE match_number = ? AND guild_id = ?`, [matchId, interaction.guildId], async (err, row) => {
      if (err || !row) return interaction.reply(`Match #${matchId} not found!`);
      if (row.scored) return interaction.reply(`Match #${matchId} has already been scored and cannot be modified!`);

      let ctTeam = row.ct_team.split(',');
      let trTeam = row.tr_team.split(',');
      const allPlayers = [...ctTeam, ...trTeam];

      if (!allPlayers.includes(oldPlayer.id)) return interaction.reply(`<@${oldPlayer.id}> is not in Match #${matchId}!`);
      if (allPlayers.includes(newPlayer.id)) return interaction.reply(`<@${newPlayer.id}> is already in Match #${matchId}!`);

      if (ctTeam.includes(oldPlayer.id)) {
        ctTeam[ctTeam.indexOf(oldPlayer.id)] = newPlayer.id;
      } else {
        trTeam[trTeam.indexOf(oldPlayer.id)] = newPlayer.id;
      }

      db.run(`UPDATE matches SET ct_team = ?, tr_team = ? WHERE match_number = ? AND guild_id = ?`, [ctTeam.join(','), trTeam.join(','), matchId, interaction.guildId]);

      const embed = new EmbedBuilder()
        .setTitle(`Match #${matchId}`)
        .setDescription(`**CT Team 1:**\n${ctTeam.map(id => `<@${id}>`).join('\n')}\n\n**TR Team 2:**\n${trTeam.map(id => `<@${id}>`).join('\n')}\n\n**Map:** ${row.map}`)
        .setColor('#00ff00')
        .setTimestamp();
      interaction.reply({ embeds: [embed] });
    });
  },
};