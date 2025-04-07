const fs = require('fs');
const path = require('path');
const { Client, Collection, GatewayIntentBits } = require('discord.js');
const { token } = require('./config.json');
const { getDb } = require('./database/db');

const client = new Client({ intents: [GatewayIntentBits.Guilds] });
client.commands = new Collection();

const getCommandFiles = (dir) => {
  let commandFiles = [];
  const files = fs.readdirSync(dir);
  for (const file of files) {
    const filePath = path.join(dir, file);
    if (fs.lstatSync(filePath).isDirectory()) {
      commandFiles = commandFiles.concat(getCommandFiles(filePath));
    } else if (file.endsWith('.js')) {
      commandFiles.push(filePath);
    }
  }
  return commandFiles;
};

const commandsPath = path.join(__dirname, 'commands');
const commandFiles = getCommandFiles(commandsPath);

for (const file of commandFiles) {
  const command = require(file);
  if (command.data && command.execute) {
    client.commands.set(command.data.name, command);
  } else {
    console.warn(`The command in "${file}" is missing the required properties (data and execute).`);
  }
}

client.once('ready', () => {
  console.log(`Bot is online as ${client.user.tag}`);
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isCommand()) return;

  const command = client.commands.get(interaction.commandName);
  if (!command) return;

  const db = getDb(interaction.guildId);

  try {
    await command.execute(interaction, db);
  } catch (error) {
    console.error('Error executing the command:', error);
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply({ content: 'An error occurred while executing the command.' });
    } else {
      await interaction.reply({ content: 'An error occurred while executing the command.', flags: 64 });
    }
  }
});

client.login(token);
