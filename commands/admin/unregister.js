const { SlashCommandBuilder } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('unregister')
    .setDescription('Unregister a player (Mods only)')
    .addUserOption(option =>
      option.setName('user')
        .setDescription('The user to unregister')
        .setRequired(true)
    ),
  async execute(interaction, db) {
    if (!interaction.member.permissions.has('ManageRoles')) {
      return interaction.reply('Only moderators can use this command!');
    }

    const targetUser = interaction.options.getUser('user');
    const userId = targetUser.id;

    db.get(`SELECT name FROM players WHERE user_id = ? AND guild_id = ?`, [userId, interaction.guildId], (err, row) => {
      if (err) return interaction.reply('Error checking player!');
      if (!row) return interaction.reply(`User <@${userId}> is not registered!`);

      db.run(`DELETE FROM players WHERE user_id = ? AND guild_id = ?`, [userId, interaction.guildId], (err) => {
        if (err) return interaction.reply('Error unregistering player!');

        interaction.reply(`Player <@${userId}> has been unregistered.`);
      });
    });
  },
};