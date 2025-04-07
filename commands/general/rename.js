const { SlashCommandBuilder } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('rename')
    .setDescription('Change your player name')
    .addStringOption(option =>
      option.setName('new_name')
        .setDescription('Your new player name')
        .setRequired(true)
    ),
  async execute(interaction, db) {
    const newName = interaction.options.getString('new_name');
    const userId = interaction.user.id;

    db.get(`SELECT name, elo FROM players WHERE user_id = ? AND guild_id = ?`, [userId, interaction.guildId], (err, row) => {
      if (err) return interaction.reply('Error checking player!');
      if (!row) return interaction.reply('You are not registered yet!');

      const newNickname = `${row.elo} | ${newName}`;
      db.run(`UPDATE players SET name = ? WHERE user_id = ? AND guild_id = ?`, [newName, userId, interaction.guildId], (err) => {
        if (err) return interaction.reply('Error updating name!');
        interaction.member.setNickname(newNickname)
          .then(() => interaction.reply(`Your name has been updated to "${newNickname}"!`))
          .catch(() => interaction.reply('Name updated in database, but I couldn’t change your nickname (check my permissions)!'));
      });
    });
  },
};