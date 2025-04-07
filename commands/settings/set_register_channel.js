const { SlashCommandBuilder } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('set_register_channel')
    .setDescription('Set the registration channel (Mods only)')
    .addChannelOption(option =>
      option.setName('channel_id')
        .setDescription('The channel for registration')
        .setRequired(true)
    ),
  async execute(interaction, db) {
    if (!interaction.member.permissions.has('ManageChannels')) {
      return interaction.reply('Only moderators can use this command!');
    }

    const channel = interaction.options.getChannel('channel_id');
    if (channel.type !== 0) return interaction.reply('Please select a text channel!');
    db.run(`INSERT OR REPLACE INTO settings (key, value, guild_id) VALUES ('register_channel', ?, ?)`, [channel.id, interaction.guildId], (err) => {
      if (err) return interaction.reply('Error setting register channel!');
      interaction.reply(`Registration channel set to <#${channel.id}>!`);
    });
  },
};