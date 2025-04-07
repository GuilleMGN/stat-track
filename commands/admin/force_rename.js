const { SlashCommandBuilder } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('force_rename')
    .setDescription('Force rename a player (Mods only)')
    .addUserOption(option =>
      option.setName('user')
        .setDescription('The user to rename')
        .setRequired(true)
    )
    .addStringOption(option =>
      option.setName('new_name')
        .setDescription('The new player name')
        .setRequired(true)
    ),
  async execute(interaction, db) {
    if (!interaction.member.permissions.has('ManageRoles')) {
      return interaction.reply('Only moderators can use this command!');
    }

    const targetUser = interaction.options.getUser('user');
    const newName = interaction.options.getString('new_name');
    const userId = targetUser.id;

    db.get(`SELECT name, elo FROM players WHERE user_id = ? AND guild_id = ?`, [userId, interaction.guildId], (err, row) => {
      if (err) return interaction.reply('Error checking player!');
      if (!row) return interaction.reply(`User <@${userId}> is not registered!`);

      const newNickname = `${row.elo} | ${newName}`;
      db.run(`UPDATE players SET name = ? WHERE user_id = ? AND guild_id = ?`, [newName, userId, interaction.guildId], (err) => {
        if (err) return interaction.reply('Error updating player name in the database!');

        const member = interaction.guild.members.cache.get(userId);
        member.setNickname(newNickname)
          .then(() => interaction.reply(`Player name updated to "${newName}" and nickname changed.`))
          .catch(() => interaction.reply('Name updated in database, but I couldn’t change the nickname (check my permissions)!'));
      });
    });
  },
};