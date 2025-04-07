const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('remove_rank')
    .setDescription('Remove a rank (Mods only)')
    .addRoleOption(option =>
      option.setName('role')
        .setDescription('The role of the rank to remove')
        .setRequired(true)
    ),
  async execute(interaction, db) {
    if (!interaction.member.permissions.has('ManageRoles')) {
      return interaction.reply('Only moderators can use this command!');
    }

    const role = interaction.options.getRole('role');

    db.get(`SELECT role_id FROM ranks WHERE role_id = ? AND guild_id = ?`, [role.id, interaction.guildId], (err, row) => {
      if (err) return interaction.reply('Error checking rank!');
      if (!row) return interaction.reply(`Rank for <@&${role.id}> not found!`);

      db.run(`DELETE FROM ranks WHERE role_id = ? AND guild_id = ?`, [role.id, interaction.guildId], (err) => {
        if (err) return interaction.reply('Error removing rank!');
        const embed = new EmbedBuilder()
          .setTitle('Rank Removed')
          .setDescription(`Rank <@&${role.id}> removed successfully!`)
          .setColor('#ff0000');
        interaction.reply({ embeds: [embed] });
      });
    });
  },
};