const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('add_rank')
    .setDescription('Add a rank with elo settings (Mods only)')
    .addRoleOption(option =>
      option.setName('role')
        .setDescription('The role for this rank')
        .setRequired(true)
    )
    .addIntegerOption(option =>
      option.setName('start')
        .setDescription('Starting elo for this rank')
        .setRequired(true)
    )
    .addIntegerOption(option =>
      option.setName('win')
        .setDescription('Elo gained per win')
        .setRequired(true)
    )
    .addIntegerOption(option =>
      option.setName('loss')
        .setDescription('Elo lost per loss')
        .setRequired(true)
    )
    .addIntegerOption(option =>
      option.setName('mvp')
        .setDescription('Elo gained per MVP')
        .setRequired(true)
    ),
  async execute(interaction, db) {
    if (!interaction.member.permissions.has('ManageRoles')) {
      return interaction.reply('Only moderators can use this command!');
    }

    const role = interaction.options.getRole('role');
    const startElo = interaction.options.getInteger('start');
    const winElo = interaction.options.getInteger('win');
    const lossElo = interaction.options.getInteger('loss');
    const mvpElo = interaction.options.getInteger('mvp');

    db.run(
      `INSERT OR REPLACE INTO ranks (role_id, start_elo, win_elo, loss_elo, mvp_elo, guild_id) VALUES (?, ?, ?, ?, ?, ?)`,
      [role.id, startElo, winElo, lossElo, mvpElo, interaction.guildId],
      (err) => {
        if (err) return interaction.reply('Error adding rank!');
        const embed = new EmbedBuilder()
          .setTitle('Rank Added')
          .setDescription(`Rank <@&${role.id}> added with Start: ${startElo}, Win: +${winElo}, Loss: -${lossElo}, MVP: +${mvpElo}`)
          .setColor('#00ff00');
        interaction.reply({ embeds: [embed] });
      }
    );
  },
};