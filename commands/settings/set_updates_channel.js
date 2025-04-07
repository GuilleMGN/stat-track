const { SlashCommandBuilder } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('set_updates_channel')
    .setDescription('Set the rank updates channel (Mods only)')
    .addChannelOption(option =>
      option.setName('channel_id')
        .setDescription('The channel for rank updates')
        .setRequired(true)
    ),
  async execute(interaction, db) {
    if (!interaction.member.permissions.has('ManageChannels')) {
      return interaction.reply('Only moderators can use this command!');
    }

    const channel = interaction.options.getChannel('channel_id');
    if (channel.type !== 0) return interaction.reply('Please select a text channel!');
    db.run(`INSERT OR REPLACE INTO settings (key, value, guild_id) VALUES ('updates_channel', ?, ?)`, [channel.id, interaction.guildId], (err) => {
      if (err) return interaction.reply('Error setting updates channel!');
      interaction.reply(`Updates channel set to <#${channel.id}>!`);
    });
  },
};