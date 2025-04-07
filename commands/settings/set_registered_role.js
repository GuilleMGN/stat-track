const { SlashCommandBuilder } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('set_registered_role')
    .setDescription('Set the registered role (Mods only)')
    .addRoleOption(option =>
      option.setName('role')
        .setDescription('The role for registered players')
        .setRequired(true)
    ),
  async execute(interaction, db) {
    if (!interaction.member.permissions.has('ManageRoles')) {
      return interaction.reply('Only moderators can use this command!');
    }

    const role = interaction.options.getRole('role');
    db.run(`INSERT OR REPLACE INTO settings (key, value, guild_id) VALUES ('registered_role', ?, ?)`, [role.id, interaction.guildId], (err) => {
      if (err) return interaction.reply('Error setting registered role!');
      interaction.reply(`Registered role set to <@&${role.id}>!`);
    });
  },
};