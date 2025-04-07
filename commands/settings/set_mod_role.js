const { SlashCommandBuilder } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('set_mod_role')
    .setDescription('Set the moderator role (Mods only)')
    .addRoleOption(option =>
      option.setName('role')
        .setDescription('The role for moderators')
        .setRequired(true)
    ),
  async execute(interaction, db) {
    if (!interaction.member.permissions.has('Administrator')) {
      return interaction.reply('Only administrators can use this command!');
    }

    const role = interaction.options.getRole('role');
    db.run(`INSERT OR REPLACE INTO settings (key, value, guild_id) VALUES ('mod_role', ?, ?)`, [role.id, interaction.guildId], (err) => {
      if (err) return interaction.reply('Error setting mod role!');
      interaction.reply(`Moderator role set to <@&${role.id}>!`);
    });
  },
};