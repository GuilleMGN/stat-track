const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('force_register')
    .setDescription('Force register a player (Mods only)')
    .addUserOption(option =>
      option.setName('user')
        .setDescription('The user to register')
        .setRequired(true)
    )
    .addStringOption(option =>
      option.setName('player_name')
        .setDescription('The player’s name to register')
        .setRequired(true)
    ),
  async execute(interaction, db) {
    if (!interaction.member.permissions.has('ManageRoles')) {
      return interaction.reply('Only moderators can use this command!');
    }

    const targetUser = interaction.options.getUser('user');
    const playerName = interaction.options.getString('player_name');
    const userId = targetUser.id;

    db.get(`SELECT name FROM players WHERE user_id = ? AND guild_id = ?`, [userId, interaction.guildId], (err, row) => {
      if (err) return interaction.reply('Error checking registration!');
      if (row) return interaction.reply('This user is already registered!');

      db.run(`INSERT INTO players (user_id, name, elo, wins, losses, mvps, guild_id) VALUES (?, ?, 0, 0, 0, 0, ?)`,
        [userId, playerName, interaction.guildId], (err) => {
          if (err) return interaction.reply('Error force registering player!');

          const embed = new EmbedBuilder()
            .setTitle('Player Force Registered')
            .setDescription(`<@${userId}> has been registered as "${playerName}"!`)
            .setColor('#00ff00');
          interaction.reply({ embeds: [embed] });
        });
    });
  },
};