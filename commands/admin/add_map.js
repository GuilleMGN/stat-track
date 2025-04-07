const { SlashCommandBuilder } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('add_map')
    .setDescription('Add a map to the database')
    .addStringOption(option =>
      option.setName('map_name')
        .setDescription('The name of the map to add')
        .setRequired(true)
    ),
  async execute(interaction, db) {
    const mapName = interaction.options.getString('map_name');
    db.run(`INSERT OR IGNORE INTO maps (map_name, guild_id) VALUES (?, ?)`, [mapName, interaction.guildId], (err) => {
      if (err) return interaction.reply('Error adding map!');
      interaction.reply(`Map "${mapName}" added successfully!`);
    });
  },
};