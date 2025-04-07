const { SlashCommandBuilder } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('remove_map')
    .setDescription('Remove a map from the database')
    .addStringOption(option =>
      option.setName('map_name')
        .setDescription('The name of the map to remove')
        .setRequired(true)
    ),
  async execute(interaction, db) {
    const mapName = interaction.options.getString('map_name');
    db.get(`SELECT map_name FROM maps WHERE map_name = ? AND guild_id = ?`, [mapName, interaction.guildId], (err, row) => {
      if (err) return interaction.reply('Error checking map!');
      if (!row) return interaction.reply(`Map "${mapName}" not found!`);
      db.run(`DELETE FROM maps WHERE map_name = ? AND guild_id = ?`, [mapName, interaction.guildId], (err) => {
        if (err) return interaction.reply('Error removing map!');
        interaction.reply(`Map "${mapName}" removed successfully!`);
      });
    });
  },
};