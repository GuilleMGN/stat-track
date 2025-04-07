const { SlashCommandBuilder } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('remove_queue')
    .setDescription('Remove a queue channel (Mods only)')
    .addChannelOption(option =>
      option.setName('channel_id')
        .setDescription('The channel to remove')
        .setRequired(true)
    ),
  async execute(interaction, db) {
    if (!interaction.member.permissions.has('ManageChannels')) {
      return interaction.reply('Only moderators can use this command!');
    }

    const channel = interaction.options.getChannel('channel_id');

    db.get(`SELECT channel_id FROM queues WHERE channel_id = ? AND guild_id = ?`, [channel.id, interaction.guildId], async (err, row) => {
      if (err || !row) {
        return interaction.reply(`<#${channel.id}> is not a queue channel!`);
      }

      const msgId = await new Promise(resolve => {
        db.get(`SELECT value FROM settings WHERE key = ? AND guild_id = ?`, [`queue_message_${channel.id}`, interaction.guildId], (err, row) => resolve(row?.value));
      });

      if (msgId) {
        const queueMsg = await channel.messages.fetch(msgId).catch(() => null);
        if (queueMsg) await queueMsg.delete();
      }

      db.run(`DELETE FROM queues WHERE channel_id = ? AND guild_id = ?`, [channel.id, interaction.guildId], err => {
        if (err) return interaction.reply('Error removing queue channel!');
        db.run(`DELETE FROM settings WHERE key = ? AND guild_id = ?`, [`queue_message_${channel.id}`, interaction.guildId], err => {
          if (err) console.error('Error removing queue message ID from settings:', err);
          interaction.reply(`Queue channel <#${channel.id}> removed!`);
        });
      });
    });
  },
};