const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('register')
    .setDescription('Register as a player')
    .addStringOption(option =>
      option.setName('player_name')
        .setDescription('Your desired player name')
        .setRequired(true)
    ),
  async execute(interaction, db) {
    const playerName = interaction.options.getString('player_name');
    const userId = interaction.user.id;
    const member = interaction.member;

    const registeredRoleId = await new Promise((resolve) => {
      db.get(`SELECT value FROM settings WHERE key = 'registered_role' AND guild_id = ?`, [interaction.guildId], (err, row) => resolve(row ? row.value : null));
    });

    const hasRegisteredRole = registeredRoleId && member.roles.cache.has(registeredRoleId);

    db.get(`SELECT name, elo FROM players WHERE user_id = ? AND guild_id = ?`, [userId, interaction.guildId], async (err, dbRow) => {
      if (err) return interaction.reply('Error checking registration!');

      if (hasRegisteredRole && dbRow) {
        return interaction.reply('You are already registered!');
      }

      if (dbRow && !hasRegisteredRole) {
        const embed = new EmbedBuilder()
          .setTitle('Registration Request')
          .setDescription(`<@${userId}> registration awaiting approval...`)
          .setColor('#ffff00')
          .setFooter({ text: `Requested Name: ${playerName} | Re-registration` });
        const row = new ActionRowBuilder()
          .addComponents(
            new ButtonBuilder().setCustomId(`approve_${userId}`).setLabel('Approve').setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId(`decline_${userId}`).setLabel('Decline').setStyle(ButtonStyle.Danger),
            new ButtonBuilder().setCustomId(`help_${userId}`).setLabel('Help').setStyle(ButtonStyle.Secondary)
          );
        await interaction.reply({ embeds: [embed], components: [row] });
        return;
      }

      if (!dbRow) {
        const embed = new EmbedBuilder()
          .setTitle('Registration Request')
          .setDescription(`<@${userId}> registration awaiting approval...`)
          .setColor('#ffff00')
          .setFooter({ text: `Requested Name: ${playerName}` });
        const row = new ActionRowBuilder()
          .addComponents(
            new ButtonBuilder().setCustomId(`approve_${userId}`).setLabel('Approve').setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId(`decline_${userId}`).setLabel('Decline').setStyle(ButtonStyle.Danger),
            new ButtonBuilder().setCustomId(`help_${userId}`).setLabel('Help').setStyle(ButtonStyle.Secondary)
          );
        await interaction.reply({ embeds: [embed], components: [row] });
      }
    });
  },
};