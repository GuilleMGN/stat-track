const { Client, EmbedBuilder, SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { MongoClient } = require('mongodb');

const http = require('http');

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Bot is online!');
});

server.listen(process.env.PORT || 3000, () => {
  console.log('HTTP server running on port', process.env.PORT || 3000);
});

const client = new Client({ intents: ['Guilds', 'GuildMessages', 'MessageContent', 'GuildMembers'] });

// MongoDB connection
let mongoClient;
let db;

async function connectToMongoDB() {
  try {
    mongoClient = new MongoClient(process.env.MONGODB_URI);
    await mongoClient.connect();
    db = mongoClient.db('stat-track');
    console.log('Connected to MongoDB');

    // Create collections
    await db.collection('maps').createIndex({ map_name: 1, guild_id: 1 }, { unique: true });
    await db.collection('players').createIndex({ user_id: 1, guild_id: 1 }, { unique: true });
    await db.collection('settings').createIndex({ key: 1, guild_id: 1 }, { unique: true });
    await db.collection('ranks').createIndex({ role_id: 1, guild_id: 1 }, { unique: true });
    await db.collection('matches').createIndex({ match_number: 1, guild_id: 1 }, { unique: true });
    await db.collection('queues').createIndex({ channel_id: 1, guild_id: 1 }, { unique: true });
  } catch (error) {
    console.error('MongoDB connection error:', error);
    process.exit(1); // Exit if connection fails
  }
}

// Return the MongoDB database instance
const getDb = async () => {
  if (!db) await connectToMongoDB();
  return db;
};

// Helper function for inserts/updates
const runQuery = async (collectionName, operation, query, values) => {
  const collection = db.collection(collectionName);
  if (operation === 'INSERT') {
    await collection.insertOne(values);
  } else if (operation === 'UPDATE') {
    await collection.updateOne(query, { $set: values });
  } else if (operation === 'DELETE') {
    await collection.deleteOne(query);
  }
};

// Helper function to mimic db.get
const getQuery = async (collectionName, query) => {
  const collection = db.collection(collectionName);
  return await collection.findOne(query);
};

// Helper function to mimic db.all
const allQuery = async (collectionName, query, options = {}) => {
  const collection = db.collection(collectionName);
  let cursor = collection.find(query);
  if (options.sort) cursor = cursor.sort(options.sort);
  if (options.limit) cursor = cursor.limit(options.limit);
  return await cursor.toArray();
};

// Assign ranked role 
const assignRankedRole = async (db, guild, userId, elo) => {
  const ranks = await allQuery('ranks', { guild_id: guild.id }, { sort: { start_elo: -1 } });
  const newRank = ranks.find(rank => elo >= rank.start_elo)?.role_id;

  let member;
  try {
    member = guild.members.cache.get(userId) || (await guild.members.fetch(userId));
  } catch (error) {
    console.error(`Failed to fetch member ${userId} for role assignment in guild ${guild.id}:`, error);
    return;
  }

  if (!member) {
    console.error(`Member ${userId} not found in guild ${guild.id}`);
    return;
  }

  const currentRoles = member.roles.cache.filter(role => ranks.some(rank => rank.role_id === role.id));
  if (newRank && !currentRoles.has(newRank)) {
    const rolesToRemove = currentRoles.filter(role => role.id !== newRank);
    await member.roles.remove(rolesToRemove).catch(console.error);
    await member.roles.add(newRank).catch(console.error);
  } else if (!newRank && currentRoles.size > 0) {
    await member.roles.remove(currentRoles).catch(console.error);
  }
};

// Get next match number 
const getNextMatchNumber = async (guildId) => {
  const matches = await allQuery('matches', { guild_id: guildId }, { sort: { match_number: -1 }, limit: 1 });
  const max = matches[0]?.match_number || 0;
  const nextNumber = max + 1;
  console.log(`Next match number for guild ${guildId}: ${nextNumber}`);
  return nextNumber;
};

// Shuffle and split players 
const shuffleAndSplit = (players) => {
  const shuffled = [...players].sort(() => Math.random() - 0.5);
  return [shuffled.slice(0, 5), shuffled.slice(5)];
};

// Get random map 
const getRandomMap = async (guildId) => {
  const maps = await allQuery('maps', { guild_id: guildId });
  const mapNames = maps.map(row => row.map_name);
  return mapNames.length ? mapNames[Math.floor(Math.random() * mapNames.length)] : 'Default Map';
};

// Update player Elo and rank 
const updatePlayerEloAndRank = async (db, guild, userId, eloChange, isMvp, bonus, channelId) => {
  const player = await getQuery('players', { user_id: userId, guild_id: guild.id });
  if (!player) {
    console.error(`Player ${userId} not found in guild ${guild.id}`);
    return { oldElo: 0, newElo: 0, name: 'Unknown' };
  }

  const oldElo = player.elo || 0;
  let newElo = Math.max(0, oldElo + eloChange);
  if (isMvp) {
    const rank = await getQuery('ranks', { start_elo: { $lte: oldElo }, guild_id: guild.id }, { sort: { start_elo: -1 } });
    newElo += rank?.mvp_elo || 0;
  }
  newElo += bonus;

  await runQuery('players', 'UPDATE', { user_id: userId, guild_id: guild.id }, { elo: newElo });

  const oldRank = await getQuery('ranks', { start_elo: { $lte: oldElo }, guild_id: guild.id }, { sort: { start_elo: -1 } });
  await assignRankedRole(db, guild, userId, newElo);
  const newRank = await getQuery('ranks', { start_elo: { $lte: newElo }, guild_id: guild.id }, { sort: { start_elo: -1 } });

  if (oldRank?.role_id !== newRank?.role_id && channelId) {
    const updatesChannel = guild.channels.cache.get(channelId);
    if (updatesChannel) {
      const embed = new EmbedBuilder()
        .setColor(newElo > oldElo ? '#00ff00' : '#ff0000')
        .setDescription(newElo > oldElo ? `@${player.name} has ranked up to <@&${newRank.role_id}>` : `@${player.name} has deranked to <@&${newRank.role_id}>`);
      updatesChannel.send({ embeds: [embed] });
    }
  }
  return { oldElo, newElo, name: player.name };
};

// Create match
const createMatch = async (db, channel, players, guildId) => {
  const matchNumber = await getNextMatchNumber(guildId);
  const [ctTeam, trTeam] = shuffleAndSplit(players);
  const map = await getRandomMap(guildId);
  const bonus = (await getQuery('settings', { key: `queue_bonus_${channel.id}`, guild_id: guildId }))?.value || 0;

  const embed = new EmbedBuilder()
    .setTitle(`Match #${matchNumber}`)
    .setDescription(
      `**CT Team 1:**\n${ctTeam.join('\n')}\n\n**TR Team 2:**\n${trTeam.join('\n')}\n\n**Map:** ${map}\n\n**Bonus Elo:** ${bonus}`
    )
    .setColor('#ff9900')
    .setTimestamp();

  const row = new ActionRowBuilder()
    .addComponents(
      new ButtonBuilder().setCustomId('next_match').setLabel('Next').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('maps').setLabel('Maps').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('teams').setLabel('Teams').setStyle(ButtonStyle.Primary)
    );

  await channel.send({ embeds: [embed], components: [row] });
};

// VC Role Check
if (!client.activeQueues) client.activeQueues = new Map();

client.on('guildMemberUpdate', async (oldMember, newMember) => {
  const guildId = newMember.guild.id;
  const db = await getDb();

  const queues = await allQuery('queues', { guild_id: guildId });
  for (const queue of queues) {
    const { channel_id, role_id, title } = queue;
    const channel = newMember.guild.channels.cache.get(channel_id);
    if (!channel) continue;

    const msgId = (await getQuery('settings', { key: `queue_message_${channel_id}`, guild_id: guildId }))?.value;
    if (!msgId) continue;

    const queueMsg = await channel.messages.fetch(msgId).catch(() => null);
    if (!queueMsg) continue;

    let embed = queueMsg.embeds[0];
    let players = embed.description.match(/\*\*Players:\*\*\n([\s\S]*?)\n\n\*\*Count:/)[1].split('\n').filter(p => p && p !== 'None');
    let count = players.length;

    const hadRole = oldMember.roles.cache.has(role_id);
    const hasRole = newMember.roles.cache.has(role_id);

    // Only proceed if the role change matches this queue's role_id
    if (!hadRole && hasRole) {
      if (players.includes(`<@${newMember.id}>`)) continue;
      if (count >= 10) continue;

      const isRegistered = await getQuery('players', { user_id: newMember.id, guild_id: guildId });
      if (!isRegistered) continue;

      players.push(`<@${newMember.id}>`);
      count++;
      embed = EmbedBuilder.from(embed)
        .setDescription(`**Players:**\n${players.join('\n')}\n\n**Count:** ${count}/10`)
        .setFooter({ text: `@${newMember.displayName} joined the queue` });

      await queueMsg.edit({ embeds: [embed] });

      // Start or reset the 1-minute timer if this is the first player
      if (count === 1) {
        const activeQueue = client.activeQueues.get(channel_id) || {};
        if (activeQueue.timer) clearTimeout(activeQueue.timer);
        if (activeQueue.interval) clearInterval(activeQueue.interval);

        activeQueue.timer = setTimeout(async () => {
          await updateQueuePeriodically(db, channel, queue, role_id, guildId);
          activeQueue.interval = setInterval(async () => {
            await updateQueuePeriodically(db, channel, queue, role_id, guildId);
          }, 60 * 1000); // 1 minute interval
          client.activeQueues.set(channel_id, activeQueue);
        }, 60 * 1000); // 1-minute initial delay
        client.activeQueues.set(channel_id, activeQueue);
      }
    } else if (hadRole && !hasRole) {
      const index = players.indexOf(`<@${newMember.id}>`);
      if (index === -1) continue;

      players.splice(index, 1);
      count--;
      embed = EmbedBuilder.from(embed)
        .setDescription(`**Players:**\n${players.length ? players.join('\n') : 'None'}\n\n**Count:** ${count}/10`)
        .setFooter({ text: `@${newMember.displayName} left the queue` });

      await queueMsg.edit({ embeds: [embed] });

      // Check if the queue should stop or continue
      const membersWithRole = newMember.guild.members.cache.filter(member => member.roles.cache.has(role_id));
      if (membersWithRole.size === 0) {
        const activeQueue = client.activeQueues.get(channel_id);
        if (activeQueue) {
          if (activeQueue.timer) clearTimeout(activeQueue.timer);
          if (activeQueue.interval) clearInterval(activeQueue.interval);
          client.activeQueues.delete(channel_id);
        }
      }
    }

    // Handle the case where count reaches 10
    if (count === 10) {
      await queueMsg.edit({ embeds: [embed] });
      await createMatch(db, channel, players, guildId);

      // Stop the periodic update loop
      const activeQueue = client.activeQueues.get(channel_id);
      if (activeQueue) {
        if (activeQueue.timer) clearTimeout(activeQueue.timer);
        if (activeQueue.interval) clearInterval(activeQueue.interval);
        client.activeQueues.delete(channel_id);
      }
    }
  }
});

// New function to handle periodic queue updates
async function updateQueuePeriodically(db, channel, queue, role_id, guildId) {
  const membersWithRole = channel.guild.members.cache.filter(member => member.roles.cache.has(role_id));
  const players = [];
  for (const member of membersWithRole.values()) {
    const isRegistered = await getQuery('players', { user_id: member.id, guild_id: guildId });
    if (isRegistered) players.push(`<@${member.id}>`);
  }

  const count = players.length;
  const queueTitle = queue.title || 'Matchmaking Queue';
  const newEmbed = new EmbedBuilder()
    .setTitle(queueTitle)
    .setDescription(`**Players:**\n${players.length ? players.join('\n') : 'None'}\n\n**Count:** ${count}/10`)
    .setColor('#0099ff')
    .setFooter({ text: 'Queue updated' })
    .setTimestamp();

  const msgId = (await getQuery('settings', { key: `queue_message_${queue.channel_id}`, guild_id: guildId }))?.value;
  const oldMsg = await channel.messages.fetch(msgId).catch(() => null);
  if (oldMsg && oldMsg.deletable) {
    await oldMsg.delete().catch(err => {
      if (err.code !== 10008) console.error(`Error deleting old queue message ${msgId}:`, err);
    });
  }

  const newQueueMsg = await channel.send({ embeds: [newEmbed] });
  await runQuery('settings', 'UPDATE', { key: `queue_message_${queue.channel_id}`, guild_id: guildId }, { value: newQueueMsg.id })
    .catch(async (error) => {
      if (error.code === 11000) {
        await runQuery('settings', 'UPDATE', { key: `queue_message_${queue.channel_id}`, guild_id: guildId }, { value: newQueueMsg.id });
      } else throw error;
    });

  // Stop the interval if no players have the role
  if (count === 0) {
    const activeQueue = client.activeQueues.get(queue.channel_id);
    if (activeQueue) {
      if (activeQueue.timer) clearTimeout(activeQueue.timer);
      if (activeQueue.interval) clearInterval(activeQueue.interval);
      client.activeQueues.delete(queue.channel_id);
    }
  }
}

// Remove the 9/10 repost logic from the original handler
// (The existing if (count < 9) { ... } else if (count >= 9) { ... } block is no longer needed and can be simplified)

// Slash commands 
const commands = [
  new SlashCommandBuilder().setName('add_map').setDescription('Add a map to the database')
    .addStringOption(option => option.setName('map_name').setDescription('The name of the map to add').setRequired(true)),
  new SlashCommandBuilder().setName('remove_map').setDescription('Remove a map from the database')
    .addStringOption(option => option.setName('map_name').setDescription('The name of the map to remove').setRequired(true)),
  new SlashCommandBuilder().setName('maps').setDescription('List all maps in the database'),
  new SlashCommandBuilder().setName('register').setDescription('Register as a player')
    .addStringOption(option => option.setName('player_name').setDescription('Your desired player name').setRequired(true)),
  new SlashCommandBuilder().setName('rename').setDescription('Change your player name')
    .addStringOption(option => option.setName('new_name').setDescription('Your new player name').setRequired(true)),
  new SlashCommandBuilder().setName('set_register_channel').setDescription('Set the registration channel (Mods only)')
    .addChannelOption(option => option.setName('channel_id').setDescription('The channel for registration').setRequired(true)),
  new SlashCommandBuilder().setName('set_registered_role').setDescription('Set the registered role (Mods only)')
    .addRoleOption(option => option.setName('role').setDescription('The role for registered players').setRequired(true)),
  new SlashCommandBuilder().setName('set_mod_role').setDescription('Set the moderator role (Mods only)')
    .addRoleOption(option => option.setName('role').setDescription('The role for moderators').setRequired(true)),
  new SlashCommandBuilder().setName('add_rank').setDescription('Add a rank with elo settings (Mods only)')
    .addRoleOption(option => option.setName('role').setDescription('The role for this rank').setRequired(true))
    .addIntegerOption(option => option.setName('start').setDescription('Starting elo for this rank').setRequired(true))
    .addIntegerOption(option => option.setName('win').setDescription('Elo gained per win').setRequired(true))
    .addIntegerOption(option => option.setName('loss').setDescription('Elo lost per loss').setRequired(true))
    .addIntegerOption(option => option.setName('mvp').setDescription('Elo gained per MVP').setRequired(true)),
  new SlashCommandBuilder().setName('ranks').setDescription('List all ranks'),
  new SlashCommandBuilder().setName('remove_rank').setDescription('Remove a rank (Mods only)')
    .addRoleOption(option => option.setName('role').setDescription('The role of the rank to remove').setRequired(true)),
  new SlashCommandBuilder().setName('force_register').setDescription('Force register a player (Mods only)')
    .addUserOption(option => option.setName('user').setDescription('The user to register').setRequired(true))
    .addStringOption(option => option.setName('player_name').setDescription('The player’s name to register').setRequired(true)),
  new SlashCommandBuilder().setName('force_rename').setDescription('Force rename a player (Mods only)')
    .addUserOption(option => option.setName('user').setDescription('The user to rename').setRequired(true))
    .addStringOption(option => option.setName('new_name').setDescription('The new player name').setRequired(true)),
  new SlashCommandBuilder().setName('unregister').setDescription('Unregister a player (Mods only)')
    .addUserOption(option => option.setName('user').setDescription('The user to unregister').setRequired(true)),
  new SlashCommandBuilder().setName('stats').setDescription('Show player stats')
    .addUserOption(option => option.setName('user').setDescription('The user to check stats for (defaults to you)').setRequired(false)),
  new SlashCommandBuilder().setName('leaderboard').setDescription('Show top 10 players by elo'),
  new SlashCommandBuilder().setName('add_queue').setDescription('Add a queue channel (Mods only)')
    .addChannelOption(option => option.setName('channel_id').setDescription('The text channel for matchmaking').setRequired(true))
    .addChannelOption(option => option.setName('voice_channel_id').setDescription('The voice channel for role assignment').setRequired(true))
    .addRoleOption(option => option.setName('role').setDescription('The role assigned to users in the voice channel').setRequired(true))
    .addStringOption(option => option.setName('title').setDescription('Custom title for the queue embed').setRequired(false))
    .addIntegerOption(option => option.setName('bonus').setDescription('Bonus Elo for winners in this queue').setRequired(false)),
  new SlashCommandBuilder().setName('remove_queue').setDescription('Remove a queue channel (Mods only)')
    .addChannelOption(option => option.setName('channel_id').setDescription('The channel to remove').setRequired(true)),
  new SlashCommandBuilder().setName('queues').setDescription('List all queue channels'),
  new SlashCommandBuilder().setName('set_results_channel').setDescription('Set the results channel (Mods only)')
    .addChannelOption(option => option.setName('channel_id').setDescription('The channel for match logs').setRequired(true)),
  new SlashCommandBuilder().setName('score').setDescription('Score a match (Mods only)')
    .addIntegerOption(option => option.setName('match_id').setDescription('The match number to score').setRequired(true))
    .addIntegerOption(option => option.setName('winner_team').setDescription('The winning team number (1 or 2)').setRequired(true))
    .addUserOption(option => option.setName('mvp1').setDescription('First MVP (optional)').setRequired(false))
    .addUserOption(option => option.setName('mvp2').setDescription('Second MVP (optional)').setRequired(false)),
  new SlashCommandBuilder().setName('sub').setDescription('Substitute a player in a match (Mods only)')
    .addIntegerOption(option => option.setName('match_id').setDescription('The match number').setRequired(true))
    .addUserOption(option => option.setName('old_player').setDescription('The player to replace').setRequired(true))
    .addUserOption(option => option.setName('new_player').setDescription('The new player').setRequired(true)),
  new SlashCommandBuilder().setName('undo').setDescription('Undo scoring for a match (Mods only)')
    .addIntegerOption(option => option.setName('match_id').setDescription('The match number to undo').setRequired(true)),
  new SlashCommandBuilder().setName('set_updates_channel').setDescription('Set the rank updates channel (Mods only)')
    .addChannelOption(option => option.setName('channel_id').setDescription('The channel for rank updates').setRequired(true)),
  new SlashCommandBuilder().setName('reset_season').setDescription('Reset all match and player statistics (Mods only)'),
  new SlashCommandBuilder().setName('custom_embed').setDescription('Create a custom embed message (Mods only)')
    .addStringOption(option => option.setName('title').setDescription('The title of the embed').setRequired(true))
    .addStringOption(option => option.setName('message').setDescription('The message body of the embed').setRequired(true))
    .addStringOption(option => option.setName('color').setDescription('The color of the embed (e.g., Red, Orange, Black, White, default: Blue)').setRequired(false)),
  new SlashCommandBuilder().setName('custom_message').setDescription('Send a custom text message (Mods only)')
    .addStringOption(option => option.setName('text').setDescription('The text to send').setRequired(true))
    .addChannelOption(option => option.setName('channel').setDescription('The channel to send the message to (default: current channel)').setRequired(false)),
].map(command => command.toJSON());

// Bot startup
client.once('ready', async () => {
  console.log('Bot is online!');
  await connectToMongoDB(); // Connect to MongoDB on startup
  try {
    await client.application.commands.set(commands);
    console.log('Slash commands registered successfully!');
  } catch (error) {
    console.error('Error registering slash commands:', error);
    console.log('Continuing with partial initialization due to command registration failure.');
  }
  console.log('Slash command registration process completed.');

  try {
    for (const guild of client.guilds.cache.values()) {
      const db = await getDb();
      const queues = await allQuery('queues', { guild_id: guild.id });
      for (const queue of queues) {
        const { channel_id, role_id, title } = queue;
        const channel = guild.channels.cache.get(channel_id);
        if (!channel) continue;

        const msgId = (await getQuery('settings', { key: `queue_message_${channel_id}`, guild_id: guild.id }))?.value;
        if (!msgId) continue;

        const queueMsg = await channel.messages.fetch(msgId).catch(() => null);
        if (!queueMsg) {
          // Message is inaccessible or deleted, create a new one
          const embed = new EmbedBuilder()
            .setTitle(title || 'Matchmaking Queue')
            .setDescription('**Players:**\nNone\n\n**Count:** 0/10')
            .setColor('#0099ff')
            .setFooter({ text: 'Queue initialized on bot startup' })
            .setTimestamp();
          const newQueueMsg = await channel.send({ embeds: [embed] });
          await runQuery('settings', 'UPDATE', { key: `queue_message_${channel_id}`, guild_id: guild.id }, { value: newQueueMsg.id })
            .catch(async (error) => {
              if (error.code === 11000) {
                await runQuery('settings', 'UPDATE', { key: `queue_message_${channel_id}`, guild_id: guild.id }, { value: newQueueMsg.id });
              } else throw error;
            });
          continue;
        }

        const membersWithRole = guild.members.cache.filter(member => member.roles.cache.has(role_id));
        const players = [];
        for (const member of membersWithRole.values()) {
          const isRegistered = await getQuery('players', { user_id: member.id, guild_id: guild.id });
          if (isRegistered) players.push(`<@${member.id}>`);
        }

        const embed = EmbedBuilder.from(queueMsg.embeds[0])
          .setDescription(`**Players:**\n${players.length ? players.join('\n') : 'None'}\n\n**Count:** ${players.length}/10`)
          .setFooter({ text: 'Queue initialized on bot startup' });
        await queueMsg.edit({ embeds: [embed] });

        if (players.length === 10) {
          await createMatch(db, channel, players, guild.id);
        }
      }
    }
    console.log('Queue initialization completed.');
  } catch (error) {
    console.error('Error during queue initialization:', error);
  }
});

// Interaction handler 
client.on('interactionCreate', async interaction => {
  if (!interaction.guild) return;
  const db = await getDb();

  const modRoleId = (await getQuery('settings', { key: 'mod_role', guild_id: interaction.guildId }))?.value;
  const isMod = modRoleId && interaction.member.roles.cache.has(modRoleId);
  const updatesChannelId = (await getQuery('settings', { key: 'updates_channel', guild_id: interaction.guildId }))?.value;

  if (interaction.isCommand()) {
    const { commandName, options } = interaction;

    if (commandName === 'force_register') {
      if (!isMod) {
        return interaction.reply({ content: 'Only moderators can use this command!', ephemeral: true });
      }
      const targetUser = options.getUser('user');
      const playerName = options.getString('player_name');
      const userId = targetUser.id;
      const member = interaction.guild.members.cache.get(userId);

      try {
        // Fetch registered role and existing player data
        const registeredRoleId = (await getQuery('settings', { key: 'registered_role', guild_id: interaction.guildId }))?.value;
        const existingPlayer = await getQuery('players', { user_id: userId, guild_id: interaction.guildId });

        // Check if user is already fully registered (in DB and has the role)
        if (existingPlayer && registeredRoleId && member.roles.cache.has(registeredRoleId)) {
          const embed = new EmbedBuilder()
            .setTitle('Player Already Registered')
            .setDescription(`<@${userId}> is already registered as "${existingPlayer.name}" with all roles assigned!`)
            .setColor('#ffff00');
          return await interaction.reply({ embeds: [embed], ephemeral: true });
        }

        // If not in DB, insert new player data
        if (!existingPlayer) {
          try {
            await runQuery('players', 'INSERT', null, {
              user_id: userId,
              name: playerName,
              elo: 0,
              wins: 0,
              losses: 0,
              mvps: 0,
              guild_id: interaction.guildId
            });
          } catch (error) {
            if (error.code === 11000) {
              console.log(`Duplicate key ignored for user ${userId} during force_register`);
            } else {
              console.error(`Error inserting player ${userId}:`, error);
              return await interaction.reply({ content: 'An error occurred while registering the player in the database!', ephemeral: true });
            }
          }
        }

        // Assign roles if missing
        const elo = existingPlayer ? existingPlayer.elo : 0;
        let rolesAssigned = false;

        if (registeredRoleId && !member.roles.cache.has(registeredRoleId)) {
          await member.roles.add(registeredRoleId).catch(err => {
            console.error(`Failed to add registered role to ${userId}:`, err);
          });
          rolesAssigned = true;
        }

        await assignRankedRole(db, interaction.guild, userId, elo).catch(err => {
          console.error(`Failed to assign rank role to ${userId}:`, err);
        });
        const rankAssigned = (await getQuery('ranks', { start_elo: { $lte: elo }, guild_id: interaction.guildId }, { sort: { start_elo: -1 } }))?.role_id;
        if (rankAssigned && !member.roles.cache.has(rankAssigned)) {
          rolesAssigned = true; // Rank role was assigned by assignRankedRole
        }

        // Update nickname
        const finalName = existingPlayer ? existingPlayer.name : playerName;
        await member.setNickname(`${elo} | ${finalName}`).catch(err => {
          console.error(`Failed to set nickname for ${userId}:`, err);
        });

        // Reply with appropriate embed
        const embed = new EmbedBuilder()
          .setTitle(existingPlayer ? 'Player Registration Updated' : 'Player Force Registered')
          .setDescription(
            existingPlayer
              ? `<@${userId}> is already registered as "${existingPlayer.name}". Roles updated if missing!`
              : `<@${userId}> has been registered as "${playerName}"!`
          )
          .setColor(rolesAssigned || !existingPlayer ? '#00ff00' : '#ffff00');
        await interaction.reply({ embeds: [embed] });
      } catch (error) {
        console.error(`Error in force_register for user ${userId}:`, error);
        if (!interaction.replied && !interaction.deferred) {
          await interaction.reply({ content: 'An unexpected error occurred while processing this command!', ephemeral: true }).catch(err => {
            console.error(`Failed to send error reply for ${userId}:`, err);
          });
        }
      }
    }

    if (commandName === 'force_rename') {
      if (!isMod) return interaction.reply('Only moderators can use this command!');
      const targetUser = options.getUser('user');
      const newName = options.getString('new_name');
      const userId = targetUser.id;

      const player = await getQuery('players', { user_id: userId, guild_id: interaction.guildId });
      if (!player) return interaction.reply(`User <@${userId}> is not registered!`);

      const oldName = player.name;
      const newNickname = `${player.elo} | ${newName}`;
      await runQuery('players', 'UPDATE', { user_id: userId, guild_id: interaction.guildId }, { name: newName });

      const member = interaction.guild.members.cache.get(userId);
      member.setNickname(newNickname)
        .then(() => {
          const embed = new EmbedBuilder()
            .setTitle('Player Renamed')
            .setDescription(`"${oldName}" has been renamed to "${newNickname}" for <@${userId}>!`)
            .setColor('#00ff00');
          interaction.reply({ embeds: [embed] });
        })
        .catch(() => interaction.reply('Name updated in database, but I couldn’t change the nickname (check my permissions)!'));
    }

    if (commandName === 'unregister') {
      if (!isMod) return interaction.reply('Only moderators can use this command!');
      const targetUser = options.getUser('user');
      const userId = targetUser.id;

      const player = await getQuery('players', { user_id: userId, guild_id: interaction.guildId });
      if (!player) return interaction.reply(`User <@${userId}> is not registered!`);

      const playerName = player.name;
      await runQuery('players', 'DELETE', { user_id: userId, guild_id: interaction.guildId });

      const member = interaction.guild.members.cache.get(userId);
      member.setNickname(null).catch(console.error);

      const registeredRoleId = (await getQuery('settings', { key: 'registered_role', guild_id: interaction.guildId }))?.value;
      if (registeredRoleId) member.roles.remove(registeredRoleId).catch(console.error);

      const rankRoles = await allQuery('ranks', { guild_id: interaction.guildId });
      rankRoles.forEach(role => member.roles.remove(role.role_id).catch(console.error));

      const embed = new EmbedBuilder()
        .setTitle('Player Unregistered')
        .setDescription(`"${playerName}" (<@${userId}>) has been unregistered!`)
        .setColor('#ff0000');
      interaction.reply({ embeds: [embed] });
    }

    if (commandName === 'stats') {
      const targetUser = options.getUser('user') || interaction.user;
      const userId = targetUser.id;

      const player = await getQuery('players', { user_id: userId, guild_id: interaction.guildId });
      if (!player) return interaction.reply('This user is not registered!');

      const ranks = await allQuery('ranks', { guild_id: interaction.guildId }, { sort: { start_elo: -1 } });
      const rankRole = ranks.find(rank => player.elo >= rank.start_elo);
      const rankTitle = rankRole ? `<@&${rankRole.role_id}>` : 'Unranked';
      const matchesPlayed = player.wins + player.losses;
      const winLossRatio = matchesPlayed > 0 ? (player.wins / matchesPlayed).toFixed(2) : 'N/A';

      const embed = new EmbedBuilder()
        .setTitle(`${player.name}'s Stats`)
        .setDescription([
          `**Name:** ${player.name}`,
          `**Rank:** ${rankTitle}`,
          `**Wins:** ${player.wins}`,
          `**Losses:** ${player.losses}`,
          `**MVPs:** ${player.mvps}`,
          `**Elo:** ${player.elo}`,
          `**Matches Played:** ${matchesPlayed}`,
          `**Win/Loss Ratio:** ${winLossRatio}`
        ].join('\n'))
        .setColor('#0099ff')
        .setTimestamp();
      interaction.reply({ embeds: [embed] });
    }

    if (commandName === 'score') {
      if (!isMod) return interaction.reply({ content: 'Only moderators can use this command!', flags: [64] });
      const matchId = options.getInteger('match_id');
      const winnerTeam = options.getInteger('winner_team');
      const mvp1 = options.getUser('mvp1');
      const mvp2 = options.getUser('mvp2');
      if (winnerTeam !== 1 && winnerTeam !== 2) return interaction.reply({ content: 'Winner team must be 1 or 2!', flags: [64] });

      // Defer the interaction to give more time for processing
      await interaction.deferReply();

      console.log(`Scoring match: matchId=${matchId}, guildId=${interaction.guildId}`);
      const match = await getQuery('matches', { match_number: matchId, guild_id: interaction.guildId });
      if (!match) return interaction.editReply(`Match #${matchId} not found!`);
      if (match.scored) return interaction.editReply(`Match #${matchId} has already been scored!`);

      const ctTeam = match.ct_team.split(',').map(id => id.trim().replace(/<@|>/g, ''));
      const trTeam = match.tr_team.split(',').map(id => id.trim().replace(/<@|>/g, ''));
      const winningTeam = winnerTeam === 1 ? ctTeam : trTeam;
      const losingTeam = winnerTeam === 1 ? trTeam : ctTeam;

      const bonus = parseInt((await getQuery('settings', { key: `queue_bonus_${interaction.channelId}`, guild_id: interaction.guildId }))?.value || 0);

      const eloChanges = [];
      try {
        for (const userId of winningTeam) {
          const playerElo = (await getQuery('players', { user_id: userId, guild_id: interaction.guildId }))?.elo || 0;
          const rank = await getQuery('ranks', { start_elo: { $lte: playerElo }, guild_id: interaction.guildId }, { sort: { start_elo: -1 } });
          const winElo = rank?.win_elo || 0;
          const isMvp = (userId === mvp1?.id || userId === mvp2?.id);
          const { oldElo, newElo, name } = await updatePlayerEloAndRank(db, interaction.guild, userId, winElo, isMvp, bonus, updatesChannelId);
          eloChanges.push(`[${oldElo}] -> [${newElo}] ${name}`);
        }
        for (const userId of losingTeam) {
          const playerElo = (await getQuery('players', { user_id: userId, guild_id: interaction.guildId }))?.elo || 0;
          const rank = await getQuery('ranks', { start_elo: { $lte: playerElo }, guild_id: interaction.guildId }, { sort: { start_elo: -1 } });
          const lossElo = -(rank?.loss_elo || 0);
          const isMvp = (userId === mvp1?.id || userId === mvp2?.id);
          const { oldElo, newElo, name } = await updatePlayerEloAndRank(db, interaction.guild, userId, lossElo, isMvp, 0, updatesChannelId);
          eloChanges.push(`[${oldElo}] -> [${newElo}] ${name}`);
        }

        await runQuery('matches', 'UPDATE', { match_number: matchId, guild_id: interaction.guildId }, {
          scored: 1,
          winner_team: winnerTeam,
          mvp1: mvp1?.id || null,
          mvp2: mvp2?.id || null,
          bonus: bonus
        });

        const embed = new EmbedBuilder()
          .setTitle(`Match #${matchId} Results`)
          .setDescription(eloChanges.join('\n'))
          .setColor('#00ff00')
          .setFooter({ text: `Match #${matchId} has been scored` });
        await interaction.editReply({ embeds: [embed] });
      } catch (error) {
        console.error(`Error scoring match #${matchId}:`, error);
        await interaction.editReply({ content: 'An error occurred while scoring the match. Please try again or contact a moderator.', flags: [64] });
      }
    }

    if (commandName === 'sub') {
      if (!isMod) return interaction.reply({ content: 'Only moderators can use this command!', flags: [4096] });
      const matchId = options.getInteger('match_id');
      const oldPlayer = options.getUser('old_player');
      const newPlayer = options.getUser('new_player');

      const match = await getQuery('matches', { match_number: matchId, guild_id: interaction.guildId });
      if (!match) return interaction.reply(`Match #${matchId} not found!`);
      if (match.scored) return interaction.reply(`Match #${matchId} has already been scored and cannot be modified!`);

      let ctTeam = match.ct_team.split(',');
      let trTeam = match.tr_team.split(',');
      const allPlayers = [...ctTeam, ...trTeam];
      if (!allPlayers.includes(oldPlayer.id)) return interaction.reply(`<@${oldPlayer.id}> is not in Match #${matchId}!`);
      if (allPlayers.includes(newPlayer.id)) return interaction.reply(`<@${newPlayer.id}> is already in Match #${matchId}!`);

      if (ctTeam.includes(oldPlayer.id)) {
        ctTeam[ctTeam.indexOf(oldPlayer.id)] = newPlayer.id;
      } else {
        trTeam[trTeam.indexOf(oldPlayer.id)] = newPlayer.id;
      }

      await runQuery('matches', 'UPDATE', { match_number: matchId, guild_id: interaction.guildId }, {
        ct_team: ctTeam.join(','),
        tr_team: trTeam.join(',')
      });

      const embed = new EmbedBuilder()
        .setTitle(`Match #${matchId}`)
        .setDescription(`**CT Team 1:**\n${ctTeam.map(id => `<@${id}>`).join('\n')}\n\n**TR Team 2:**\n${trTeam.map(id => `<@${id}>`).join('\n')}\n\n**Map:** ${match.map}`)
        .setColor('#00ff00')
        .setTimestamp();
      interaction.reply({ embeds: [embed] });
    }

    if (commandName === 'undo') {
      if (!isMod) return interaction.reply({ content: 'Only moderators can use this command!', flags: [4096] });
      const matchId = options.getInteger('match_id');

      const match = await getQuery('matches', { match_number: matchId, guild_id: interaction.guildId });
      if (!match) return interaction.reply(`Match #${matchId} not found!`);
      if (!match.scored) return interaction.reply(`Match #${matchId} has not been scored!`);

      const ctTeam = match.ct_team.split(',').map(id => id.trim().replace(/<@|>/g, ''));
      const trTeam = match.tr_team.split(',').map(id => id.trim().replace(/<@|>/g, ''));
      const winningTeam = match.winner_team === 1 ? ctTeam : trTeam;
      const losingTeam = match.winner_team === 1 ? trTeam : ctTeam;
      const mvp1 = match.mvp1;
      const mvp2 = match.mvp2;
      const bonus = match.bonus || 0;

      const eloChanges = [];
      for (const userId of winningTeam) {
        const player = await getQuery('players', { user_id: userId, guild_id: interaction.guildId });
        if (!player) {
          eloChanges.push(`[N/A] -> [N/A] Unknown (${userId})`);
          continue;
        }
        const currentElo = player.elo;
        const rank = await getQuery('ranks', { start_elo: { $lte: currentElo }, guild_id: interaction.guildId }, { sort: { start_elo: -1 } });
        const winElo = rank?.win_elo || 0;
        let eloChange = -winElo;
        const isMvp = (userId === mvp1 || userId === mvp2);
        if (isMvp) {
          const mvpElo = rank?.mvp_elo || 0;
          eloChange -= mvpElo;
        }
        eloChange -= bonus;
        const newElo = Math.max(0, currentElo + eloChange);
        await runQuery('players', 'UPDATE', { user_id: userId, guild_id: interaction.guildId }, { elo: newElo });
        await assignRankedRole(db, interaction.guild, userId, newElo);
        eloChanges.push(`[${currentElo}] -> [${newElo}] ${player.name}`);
      }
      for (const userId of losingTeam) {
        const player = await getQuery('players', { user_id: userId, guild_id: interaction.guildId });
        if (!player) {
          eloChanges.push(`[N/A] -> [N/A] Unknown (${userId})`);
          continue;
        }
        const currentElo = player.elo;
        const rank = await getQuery('ranks', { start_elo: { $lte: currentElo }, guild_id: interaction.guildId }, { sort: { start_elo: -1 } });
        const lossElo = rank?.loss_elo || 0;
        const simulatedOldElo = currentElo;
        const simulatedScoreChange = -(lossElo);
        const simulatedNewEloDuringScore = Math.max(0, simulatedOldElo + simulatedScoreChange);
        let eloChange = simulatedNewEloDuringScore < simulatedOldElo ? lossElo : 0;
        const isMvp = (userId === mvp1 || userId === mvp2);
        if (isMvp) {
          const mvpElo = rank?.mvp_elo || 0;
          eloChange -= mvpElo;
        }
        const newElo = Math.max(0, currentElo + eloChange);
        await runQuery('players', 'UPDATE', { user_id: userId, guild_id: interaction.guildId }, { elo: newElo });
        await assignRankedRole(db, interaction.guild, userId, newElo);
        eloChanges.push(`[${currentElo}] -> [${newElo}] ${player.name}`);
      }

      await runQuery('matches', 'UPDATE', { match_number: matchId, guild_id: interaction.guildId }, {
        scored: 0,
        winner_team: null,
        mvp1: null,
        mvp2: null,
        bonus: null
      });

      const embed = new EmbedBuilder()
        .setTitle(`Match #${matchId} Undo Results`)
        .setDescription(eloChanges.length > 0 ? eloChanges.join('\n') : 'No Elo changes applied (players not found).')
        .setColor('#ff0000')
        .setFooter({ text: `Match #${matchId} has been unscored` });
      interaction.reply({ embeds: [embed] });
    }

    if (commandName === 'set_updates_channel') {
      if (!isMod) return interaction.reply({ content: 'Only moderators can use this command!', flags: [4096] });
      const channel = options.getChannel('channel_id');
      if (channel.type !== 0) return interaction.reply('Please select a text channel!');

      await runQuery('settings', 'INSERT', null, { key: 'updates_channel', value: channel.id, guild_id: interaction.guildId });
      interaction.reply(`Updates channel set to <#${channel.id}>!`);
    }

    if (commandName === 'leaderboard') {
      const players = await allQuery('players', { guild_id: interaction.guildId }, { sort: { elo: -1 } });
      const pageSize = 10;
      let page = 0;

      const getLeaderboardEmbed = (players, page) => {
        const start = page * pageSize;
        const end = start + pageSize;
        const pagePlayers = players.slice(start, end);
        const leaderboard = pagePlayers.length > 0
          ? pagePlayers.map((row, index) => `${start + index + 1}. ${row.elo} | ${row.name}`).join('\n')
          : 'No players on this page.';
        return new EmbedBuilder()
          .setTitle('Leaderboard - Top Players')
          .setDescription(leaderboard)
          .setColor('#FFD700')
          .setFooter({ text: `Page ${page + 1} of ${Math.ceil(players.length / pageSize)} | Total Players: ${players.length}` })
          .setTimestamp();
      };

      const getButtons = (page, totalPages) => {
        return new ActionRowBuilder()
          .addComponents(
            new ButtonBuilder()
              .setCustomId('prev_leaderboard')
              .setLabel('Prev')
              .setStyle(ButtonStyle.Primary)
              .setDisabled(page === 0),
            new ButtonBuilder()
              .setCustomId('next_leaderboard')
              .setLabel('Next')
              .setStyle(ButtonStyle.Primary)
              .setDisabled(page === totalPages - 1 || players.length === 0)
          );
      };

      const totalPages = Math.ceil(players.length / pageSize);
      const initialEmbed = getLeaderboardEmbed(players, page);
      const initialButtons = getButtons(page, totalPages);

      const message = await interaction.reply({ embeds: [initialEmbed], components: [initialButtons], fetchReply: true });

      // Store the active leaderboard message for this guild
      if (!client.activeLeaderboards) client.activeLeaderboards = new Map();
      const guildId = interaction.guildId;
      const previousLeaderboard = client.activeLeaderboards.get(guildId);

      // Disable buttons on the previous leaderboard
      if (previousLeaderboard) {
        const disabledButtons = new ActionRowBuilder()
          .addComponents(
            new ButtonBuilder().setCustomId('prev_leaderboard').setLabel('Prev').setStyle(ButtonStyle.Primary).setDisabled(true),
            new ButtonBuilder().setCustomId('next_leaderboard').setLabel('Next').setStyle(ButtonStyle.Primary).setDisabled(true)
          );
        await previousLeaderboard.edit({ components: [disabledButtons] }).catch(() => { }); // Ignore if message is deleted
      }

      // Set the new active leaderboard
      client.activeLeaderboards.set(guildId, message);

      const collector = message.createMessageComponentCollector(); // No time limit

      collector.on('collect', async i => {
        if (i.customId === 'prev_leaderboard' && page > 0) {
          page--;
        } else if (i.customId === 'next_leaderboard' && page < totalPages - 1) {
          page++;
        } else {
          return;
        }

        const updatedEmbed = getLeaderboardEmbed(players, page);
        const updatedButtons = getButtons(page, totalPages);
        await i.update({ embeds: [updatedEmbed], components: [updatedButtons] });
      });

      collector.on('end', () => {
        // Only disable if explicitly stopped (not by timeout)
        if (client.activeLeaderboards.get(guildId) === message) {
          const disabledButtons = new ActionRowBuilder()
            .addComponents(
              new ButtonBuilder().setCustomId('prev_leaderboard').setLabel('Prev').setStyle(ButtonStyle.Primary).setDisabled(true),
              new ButtonBuilder().setCustomId('next_leaderboard').setLabel('Next').setStyle(ButtonStyle.Primary).setDisabled(true)
            );
          message.edit({ components: [disabledButtons] }).catch(() => { }); // Ignore if message deleted
        }
      });
    }

    if (commandName === 'add_rank') {
      if (!isMod) return interaction.reply('Only moderators can use this command!');
      const role = options.getRole('role');
      const startElo = options.getInteger('start');
      const winElo = options.getInteger('win');
      const lossElo = options.getInteger('loss');
      const mvpElo = options.getInteger('mvp');

      // Check if a rank with the same start_elo and guild_id already exists
      const existingRank = await getQuery('ranks', { start_elo: startElo, guild_id: interaction.guildId });
      if (existingRank) {
        // Update the existing rank
        await runQuery('ranks', 'UPDATE', { start_elo: startElo, guild_id: interaction.guildId }, {
          role_id: role.id,
          win_elo: winElo,
          loss_elo: lossElo,
          mvp_elo: mvpElo
        });
        const embed = new EmbedBuilder()
          .setTitle('Rank Updated')
          .setDescription(`Rank with starting Elo ${startElo} updated to <@&${role.id}> with Win: +${winElo}, Loss: -${lossElo}, MVP: +${mvpElo}`)
          .setColor('#00ff00');
        interaction.reply({ embeds: [embed] });
      } else {
        // Insert a new rank
        await runQuery('ranks', 'INSERT', null, {
          role_id: role.id,
          start_elo: startElo,
          win_elo: winElo,
          loss_elo: lossElo,
          mvp_elo: mvpElo,
          guild_id: interaction.guildId
        });
        const embed = new EmbedBuilder()
          .setTitle('Rank Added')
          .setDescription(`Rank <@&${role.id}> added with Start: ${startElo}, Win: +${winElo}, Loss: -${lossElo}, MVP: +${mvpElo}`)
          .setColor('#00ff00');
        interaction.reply({ embeds: [embed] });
      }
    }

    if (commandName === 'ranks') {
      const ranks = await allQuery('ranks', { guild_id: interaction.guildId }, { sort: { start_elo: -1 } });
      const rankList = ranks.length > 0
        ? ranks.map(row => `<@&${row.role_id}> ST: ${row.start_elo} W:(+${row.win_elo}) L:(-${row.loss_elo}) MVP:(+${row.mvp_elo})`).join('\n')
        : 'No ranks defined.';
      const embed = new EmbedBuilder()
        .setTitle('Rank List')
        .setDescription(rankList)
        .setColor('#0099ff')
        .setFooter({ text: `Total Ranks: ${ranks.length}` })
        .setTimestamp();
      interaction.reply({ embeds: [embed] });
    }

    if (commandName === 'remove_rank') {
      if (!isMod) return interaction.reply('Only moderators can use this command!');
      const role = options.getRole('role');

      const rank = await getQuery('ranks', { role_id: role.id, guild_id: interaction.guildId });
      if (!rank) return interaction.reply(`Rank for <@&${role.id}> not found!`);

      await runQuery('ranks', 'DELETE', { role_id: role.id, guild_id: interaction.guildId });

      const embed = new EmbedBuilder()
        .setTitle('Rank Removed')
        .setDescription(`Rank <@&${role.id}> removed successfully!`)
        .setColor('#ff0000');
      interaction.reply({ embeds: [embed] });
    }

    if (commandName === 'register') {
      const registerChannelId = (await getQuery('settings', { key: 'register_channel', guild_id: interaction.guildId }))?.value;
      if (registerChannelId && interaction.channelId !== registerChannelId) {
        return interaction.reply(`Please use this command in <#${registerChannelId}>!`);
      }

      const playerName = options.getString('player_name');
      const userId = interaction.user.id;
      const member = interaction.member;

      const registeredRoleId = (await getQuery('settings', { key: 'registered_role', guild_id: interaction.guildId }))?.value;
      const existingPlayer = await getQuery('players', { user_id: userId, guild_id: interaction.guildId });

      // If user is already registered
      if (existingPlayer) {
        // Check if roles or nickname are missing, indicating a rejoin
        const hasRegisteredRole = registeredRoleId ? member.roles.cache.has(registeredRoleId) : true;
        const currentNickname = member.nickname || `${member.user.username}#${member.user.discriminator}`;
        const expectedNickname = `${existingPlayer.elo} | ${existingPlayer.name}`;
        const needsRoleUpdate = !hasRegisteredRole || currentNickname !== expectedNickname;

        if (needsRoleUpdate) {
          try {
            // Reassign registered role if missing
            if (registeredRoleId && !member.roles.cache.has(registeredRoleId)) {
              await member.roles.add(registeredRoleId).catch(err => {
                console.error(`Failed to add registered role to ${userId}:`, err);
              });
            }

            // Reassign rank role based on existing Elo
            await assignRankedRole(db, interaction.guild, userId, existingPlayer.elo).catch(err => {
              console.error(`Failed to assign rank role to ${userId}:`, err);
            });

            // Update nickname to match Elo and name
            await member.setNickname(expectedNickname).catch(err => {
              console.error(`Failed to set nickname for ${userId}:`, err);
            });

            // Send success message for role restoration
            const embed = new EmbedBuilder()
              .setTitle('Player Roles Restored')
              .setDescription(`<@${userId}> was already registered as "${existingPlayer.name}". Roles and nickname have been restored!`)
              .setColor('#00ff00')
              .setTimestamp();
            await interaction.reply({ embeds: [embed] });
          } catch (error) {
            console.error(`Error restoring roles for user ${userId}:`, error);
            const embed = new EmbedBuilder()
              .setTitle('Registration Error')
              .setDescription(`An error occurred while restoring roles for <@${userId}>. Please try again or contact a moderator.`)
              .setColor('#ff0000');
            await interaction.reply({ embeds: [embed] });
          }
        } else {
          // User is registered and roles/nickname are intact, suggest rename
          const embed = new EmbedBuilder()
            .setTitle('Registration Failed')
            .setDescription(`<@${userId}> is already registered as "${existingPlayer.name}"! Use /rename to change your name.`)
            .setColor('#ff0000');
          await interaction.reply({ embeds: [embed] });
        }
      } else {
        // Register new player (original logic)
        try {
          await runQuery('players', 'INSERT', null, {
            user_id: userId,
            name: playerName,
            elo: 0,
            wins: 0,
            losses: 0,
            mvps: 0,
            guild_id: interaction.guildId
          });

          if (registeredRoleId) {
            await member.roles.add(registeredRoleId).catch(err => {
              console.error(`Failed to add registered role to ${userId}:`, err);
            });
          }
          await assignRankedRole(db, interaction.guild, userId, 0).catch(err => {
            console.error(`Failed to assign rank role to ${userId}:`, err);
          });

          await member.setNickname(`0 | ${playerName}`).catch(err => {
            console.error(`Failed to set nickname for ${userId}:`, err);
          });

          const embed = new EmbedBuilder()
            .setTitle('Player Registered')
            .setDescription(`<@${userId}> has successfully registered as "${playerName}"!`)
            .setColor('#00ff00')
            .setTimestamp();
          await interaction.reply({ embeds: [embed] });
        } catch (error) {
          console.error(`Error registering user ${userId}:`, error);
          if (error.code === 11000) {
            const embed = new EmbedBuilder()
              .setTitle('Registration Failed')
              .setDescription(`<@${userId}> is already registered! Use /rename to change your name.`)
              .setColor('#ff0000');
            await interaction.reply({ embeds: [embed] });
          } else {
            const embed = new EmbedBuilder()
              .setTitle('Registration Error')
              .setDescription(`An error occurred while registering <@${userId}>. Please try again later.`)
              .setColor('#ff0000');
            await interaction.reply({ embeds: [embed] });
          }
        }
      }
    }

    if (commandName === 'rename') {
      const newName = options.getString('new_name');
      const userId = interaction.user.id;

      const player = await getQuery('players', { user_id: userId, guild_id: interaction.guildId });
      if (!player) return interaction.reply('You are not registered yet!');

      const newNickname = `${player.elo} | ${newName}`;
      await runQuery('players', 'UPDATE', { user_id: userId, guild_id: interaction.guildId }, { name: newName });

      interaction.member.setNickname(newNickname)
        .then(() => interaction.reply(`Your name has been updated to "${newNickname}"!`))
        .catch(() => interaction.reply('Name updated in database, but I couldn’t change your nickname (check my permissions)!'));
    }

    if (commandName === 'set_register_channel') {
      if (!isMod) return interaction.reply('Only moderators can use this command!');
      const channel = options.getChannel('channel_id');
      if (channel.type !== 0) return interaction.reply('Please select a text channel!');

      await runQuery('settings', 'INSERT', null, { key: 'register_channel', value: channel.id, guild_id: interaction.guildId });
      interaction.reply(`Registration channel set to <#${channel.id}>!`);
    }

    if (commandName === 'set_registered_role') {
      if (!isMod) return interaction.reply('Only moderators can use this command!');
      const role = options.getRole('role');

      await runQuery('settings', 'INSERT', null, { key: 'registered_role', value: role.id, guild_id: interaction.guildId });
      interaction.reply(`Registered role set to <@&${role.id}>!`);
    }

    if (commandName === 'set_mod_role') {
      if (!isMod && !interaction.member.permissions.has('Administrator')) return interaction.reply('Only moderators or admins can use this command!');
      const role = options.getRole('role');

      await runQuery('settings', 'INSERT', null, { key: 'mod_role', value: role.id, guild_id: interaction.guildId });
      interaction.reply(`Moderator role set to <@&${role.id}>!`);
    }

    if (commandName === 'add_map') {
      const mapName = options.getString('map_name');

      const existingMap = await getQuery('maps', { map_name: mapName, guild_id: interaction.guildId });
      if (!existingMap) {
        await runQuery('maps', 'INSERT', null, { map_name: mapName, guild_id: interaction.guildId });
        interaction.reply(`Map "${mapName}" added successfully!`);
      } else {
        interaction.reply(`Map "${mapName}" already exists!`);
      }
    }

    if (commandName === 'remove_map') {
      const mapName = options.getString('map_name');

      const map = await getQuery('maps', { map_name: mapName, guild_id: interaction.guildId });
      if (!map) return interaction.reply(`Map "${mapName}" not found!`);

      await runQuery('maps', 'DELETE', { map_name: mapName, guild_id: interaction.guildId });
      interaction.reply(`Map "${mapName}" removed successfully!`);
    }

    if (commandName === 'maps') {
      const maps = await allQuery('maps', { guild_id: interaction.guildId }, { sort: { _id: 1 } });
      const mapList = maps.map(row => row.map_name).join('\n') || 'No maps found.';
      const embed = new EmbedBuilder()
        .setTitle('Map List')
        .setDescription(mapList)
        .setColor('#0099ff')
        .setFooter({ text: `Total Maps: ${maps.length}` })
        .setTimestamp();
      interaction.reply({ embeds: [embed] });
    }

    if (commandName === 'add_queue') {
      if (!isMod) return interaction.reply('Only moderators can use this command!');
      const channel = options.getChannel('channel_id');
      const voiceChannel = options.getChannel('voice_channel_id');
      const role = options.getRole('role');
      const title = options.getString('title') || 'Matchmaking Queue';
      const bonus = options.getInteger('bonus') || 0;

      if (channel.type !== 0) return interaction.reply('The channel_id must be a text channel!');
      if (voiceChannel.type !== 2) return interaction.reply('The voice_channel_id must be a voice channel!');

      try {
        // Insert or update queue entry
        const existingQueue = await getQuery('queues', { channel_id: channel.id, guild_id: interaction.guildId });
        if (!existingQueue) {
          await runQuery('queues', 'INSERT', null, {
            channel_id: channel.id,
            guild_id: interaction.guildId,
            title,
            voice_channel_id: voiceChannel.id,
            role_id: role.id
          });
        } else {
          await runQuery('queues', 'UPDATE', { channel_id: channel.id, guild_id: interaction.guildId }, {
            title,
            voice_channel_id: voiceChannel.id,
            role_id: role.id
          });
        }

        const embed = new EmbedBuilder()
          .setTitle(title)
          .setDescription('**Players:**\nNone\n\n**Count:** 0/10')
          .setColor('#0099ff')
          .setFooter({ text: 'Queue initialized' })
          .setTimestamp();

        const msg = await channel.send({ embeds: [embed] });

        // Insert or update settings
        await runQuery('settings', 'INSERT', null, { key: `queue_message_${channel.id}`, value: msg.id, guild_id: interaction.guildId })
          .catch(async (error) => {
            if (error.code === 11000) {
              await runQuery('settings', 'UPDATE', { key: `queue_message_${channel.id}`, guild_id: interaction.guildId }, { value: msg.id });
            } else throw error;
          });
        await runQuery('settings', 'INSERT', null, { key: `queue_bonus_${channel.id}`, value: bonus.toString(), guild_id: interaction.guildId })
          .catch(async (error) => {
            if (error.code === 11000) {
              await runQuery('settings', 'UPDATE', { key: `queue_bonus_${channel.id}`, guild_id: interaction.guildId }, { value: bonus.toString() });
            } else throw error;
          });

        interaction.reply(`Queue channel set to <#${channel.id}> with voice channel <#${voiceChannel.id}> and role <@&${role.id}>!`);
      } catch (error) {
        console.error('Add queue error:', error);
        interaction.reply('Error adding queue channel!');
      }
    }

    if (commandName === 'remove_queue') {
      if (!isMod) return interaction.reply('Only moderators can use this command!');
      const channel = options.getChannel('channel_id');

      const queue = await getQuery('queues', { channel_id: channel.id, guild_id: interaction.guildId });
      if (!queue) return interaction.reply(`<#${channel.id}> is not a queue channel!`);

      const msgId = (await getQuery('settings', { key: `queue_message_${channel.id}`, guild_id: interaction.guildId }))?.value;
      if (msgId) {
        try {
          const queueMsg = await channel.messages.fetch(msgId).catch(() => null);
          if (queueMsg) await queueMsg.delete().catch(err => {
            if (err.code === 10008) {
              console.log(`Queue message ${msgId} already deleted or inaccessible in channel ${channel.id}`);
            } else {
              console.error(`Error deleting queue message ${msgId}:`, err);
            }
          });
        } catch (error) {
          console.error(`Error fetching queue message ${msgId}:`, error);
        }
      }

      await runQuery('queues', 'DELETE', { channel_id: channel.id, guild_id: interaction.guildId });
      await runQuery('settings', 'DELETE', { key: `queue_message_${channel.id}`, guild_id: interaction.guildId });
      await runQuery('settings', 'DELETE', { key: `queue_bonus_${channel.id}`, guild_id: interaction.guildId });

      interaction.reply(`Queue channel <#${channel.id}> removed!`);
    }

    if (commandName === 'queues') {
      const queues = await allQuery('queues', { guild_id: interaction.guildId }, { sort: { _id: 1 } });
      const queueList = await Promise.all(queues.map(async row => {
        const bonus = parseInt((await getQuery('settings', { key: `queue_bonus_${row.channel_id}`, guild_id: interaction.guildId }))?.value || 0);
        return (
          `**Text Channel:** <#${row.channel_id}>\n` +
          `**Voice Channel:** <#${row.voice_channel_id}>\n` +
          `**Role:** <@&${row.role_id}>\n` +
          `**Title:** ${row.title}\n` +
          `**Bonus Elo:** ${bonus}`
        );
      }));

      const embed = new EmbedBuilder()
        .setTitle('Queue Channels')
        .setDescription(queueList.length ? queueList.join('\n\n') : 'No queue channels set.')
        .setColor('#0099ff')
        .setTimestamp();
      interaction.reply({ embeds: [embed] });
    }

    if (commandName === 'reset_season') {
      if (!isMod) return interaction.reply({ content: 'Only moderators can use this command!', flags: [4096] });

      const embed = new EmbedBuilder()
        .setTitle('Reset Season Confirmation')
        .setDescription('You are about to reset all statistics:\n- All matches will be cleared (reverting to 0 matches played).\n- All player Elos will be reset to 0.\n- Player stats (wins, losses, MVPs) will be reset to default values.\n\n**Would you still like to proceed?**')
        .setColor('#ff0000')
        .setTimestamp();

      const row = new ActionRowBuilder()
        .addComponents(
          new ButtonBuilder().setCustomId('reset_season_yes').setLabel('Yes').setStyle(ButtonStyle.Danger),
          new ButtonBuilder().setCustomId('reset_season_no').setLabel('No').setStyle(ButtonStyle.Secondary)
        );

      await interaction.reply({ embeds: [embed], components: [row], flags: [4096] });
    }

    if (commandName === 'custom_embed') {
      if (!isMod) {
        return interaction.reply({ content: 'Only moderators can use this command!', ephemeral: true });
      }

      const title = options.getString('title').trim();
      const message = options.getString('message').trim();
      const colorInput = options.getString('color')?.trim() || 'Blue'; // Default to Blue

      // Check for blank inputs
      if (!title) {
        return interaction.reply({ content: 'The title cannot be blank!', ephemeral: true });
      }
      if (!message) {
        return interaction.reply({ content: 'The message cannot be blank!', ephemeral: true });
      }

      // Predefined color mapping (case-insensitive)
      const colorMap = {
        red: 0xFF0000,
        orange: 0xFFA500,
        yellow: 0xFFFF00,
        green: 0x00FF00,
        blue: 0x0099FF, // Default
        purple: 0x800080,
        black: 0x000000,
        white: 0xFFFFFF,
        gray: 0x808080,
        pink: 0xFFC1CC
      };

      // Normalize color input to lowercase for matching
      const normalizedColor = colorInput.toLowerCase();
      const color = colorMap[normalizedColor];

      if (!color && colorInput !== 'Blue') { // Allow default even if mistyped slightly
        return interaction.reply({
          content: 'Invalid color! Use one of: Red, Orange, Yellow, Green, Blue, Purple, Black, White, Gray, Pink',
          ephemeral: true
        });
      }

      try {
        // Create the embed
        const embed = new EmbedBuilder()
          .setTitle(title)
          .setDescription(message)
          .setColor(color || colorMap.blue) // Fallback to blue if somehow undefined
          .setTimestamp();

        // Send the embed as a separate message in the same channel
        await interaction.channel.send({ embeds: [embed] });

        // Reply with ephemeral success message
        await interaction.reply({ content: 'Embed message created!', ephemeral: true });
      } catch (error) {
        console.error(`Error in custom_embed for guild ${interaction.guildId}:`, error);
        await interaction.reply({ content: 'An error occurred while creating the embed! Please try again.', ephemeral: true });
      }
    }

    if (commandName === 'custom_message') {
      if (!isMod) {
        return interaction.reply({ content: 'Only moderators can use this command!', ephemeral: true });
      }

      const text = options.getString('text').trim();
      const channel = options.getChannel('channel') || interaction.channel;

      // Check for blank text
      if (!text) {
        return interaction.reply({ content: 'The text cannot be blank!', ephemeral: true });
      }

      // Ensure the channel is a text channel
      if (channel.type !== 0) { // 0 = GuildText
        return interaction.reply({ content: 'The specified channel must be a text channel!', ephemeral: true });
      }

      try {
        // Send the text as a standalone message in the specified channel
        await channel.send(text);
      } catch (error) {
        console.error(`Error in custom_message for guild ${interaction.guildId}:`, error);
        await interaction.reply({ content: 'An error occurred while sending the message! Check bot permissions or try again.', ephemeral: true });
      }
    }

    if (commandName === 'set_results_channel') {
      if (!isMod) return interaction.reply('Only moderators can use this command!');
      const channel = options.getChannel('channel_id');
      if (channel.type !== 0) return interaction.reply('Please select a text channel!');

      await runQuery('settings', 'INSERT', null, { key: 'results_channel', value: channel.id, guild_id: interaction.guildId });
      interaction.reply(`Results channel set to <#${channel.id}>!`);
    }
  }

  if (interaction.isButton()) {
    const { customId, user, guildId, channelId } = interaction;
    const db = await getDb();

    if (customId.startsWith('approve_') || customId.startsWith('decline_')) {
      const [action, userId] = customId.split('_');
      if (!isMod && (action === 'approve' || action === 'decline')) {
        return interaction.reply({ content: 'Only moderators can approve/decline registrations!', flags: [64] });
      }

      const embed = interaction.message.embeds[0];
      const playerName = embed.footer?.text.split(': ')[1].split(' | ')[0];

      if (action === 'approve') {
        if (!playerName) return interaction.reply({ content: 'Error: Player name not found in request!', flags: [64] });

        const dbRow = await getQuery('players', { user_id: userId, guild_id: guildId });
        const member = interaction.guild.members.cache.get(userId);
        const registeredRoleId = (await getQuery('settings', { key: 'registered_role', guild_id: guildId }))?.value;

        if (dbRow) {
          if (dbRow.name !== playerName) {
            await runQuery('players', 'UPDATE', { user_id: userId, guild_id: guildId }, { name: playerName });
          }
          if (registeredRoleId) member.roles.add(registeredRoleId).catch(console.error);
          await assignRankedRole(db, interaction.guild, userId, dbRow.elo);
          member.setNickname(`${dbRow.elo} | ${playerName}`).catch(console.error);
          const updatedEmbed = EmbedBuilder.from(embed)
            .setDescription(`<@${userId}> registration approved!`)
            .setColor('#00ff00')
            .setFooter({ text: `Re-registered as: ${playerName}` });
          await interaction.update({ embeds: [updatedEmbed], components: [] });
        } else {
          await runQuery('players', 'INSERT', null, {
            user_id: userId,
            name: playerName,
            elo: 0,
            wins: 0,
            losses: 0,
            mvps: 0,
            guild_id: guildId
          });
          if (registeredRoleId) member.roles.add(registeredRoleId).catch(console.error);
          await assignRankedRole(db, interaction.guild, userId, 0);
          member.setNickname(`0 | ${playerName}`).catch(console.error);
          const updatedEmbed = EmbedBuilder.from(embed)
            .setDescription(`<@${userId}> registration approved!`)
            .setColor('#00ff00')
            .setFooter({ text: `Registered as: ${playerName}` });
          await interaction.update({ embeds: [updatedEmbed], components: [] });
        }
      } else if (action === 'decline') {
        const updatedEmbed = EmbedBuilder.from(embed)
          .setDescription(`<@${userId}> registration declined!`)
          .setColor('#ff0000')
          .setFooter({ text: embed.footer?.text });
        await interaction.update({ embeds: [updatedEmbed], components: [] });
      }
    }

    if (customId === 'next_match' || customId === 'maps' || customId === 'teams') {
      if (!isMod) return interaction.reply({ content: 'Only moderators can use this!', flags: [64] });

      const matchEmbed = interaction.message.embeds[0];
      if (!matchEmbed || !matchEmbed.title || !matchEmbed.title.match(/Match #\d+/)) {
        return interaction.reply({ content: 'Invalid match embed!', flags: [64] });
      }

      try {
        if (customId === 'next_match') {
          const matchNumberMatch = matchEmbed.title.match(/#(\d+)/);
          if (!matchNumberMatch) throw new Error('Could not extract match number from title');
          const matchNumber = parseInt(matchNumberMatch[1]);

          const ctMatch = matchEmbed.description.match(/\*\*CT Team 1:\*\*\n([\s\S]*?)\n\n\*\*TR Team 2:/);
          const trMatch = matchEmbed.description.match(/\*\*TR Team 2:\*\*\n([\s\S]*?)\n\n\*\*Map:/);
          const mapMatch = matchEmbed.description.match(/\*\*Map:\*\* (.*)/);
          if (!ctMatch || !trMatch || !mapMatch) throw new Error('Invalid embed description format for teams or map');

          const ctTeam = ctMatch[1].split('\n').filter(line => line.trim()).map(id => id.replace(/<@|>/g, ''));
          const trTeam = trMatch[1].split('\n').filter(line => line.trim()).map(id => id.replace(/<@|>/g, ''));
          const map = mapMatch[1];

          await runQuery('matches', 'INSERT', null, {
            match_number: matchNumber,
            ct_team: ctTeam.join(','),
            tr_team: trTeam.join(','),
            map,
            guild_id: guildId,
            scored: 0
          });

          const resultsChannelId = (await getQuery('settings', { key: 'results_channel', guild_id: guildId }))?.value;
          if (resultsChannelId) {
            const resultsChannel = interaction.guild.channels.cache.get(resultsChannelId);
            if (resultsChannel) await resultsChannel.send({ embeds: [matchEmbed] });
          }

          const disabledRow = new ActionRowBuilder()
            .addComponents(
              new ButtonBuilder().setCustomId('next_match').setLabel('Next').setStyle(ButtonStyle.Success).setDisabled(true),
              new ButtonBuilder().setCustomId('maps').setLabel('Maps').setStyle(ButtonStyle.Primary).setDisabled(true),
              new ButtonBuilder().setCustomId('teams').setLabel('Teams').setStyle(ButtonStyle.Primary).setDisabled(true)
            );
          await interaction.message.edit({ embeds: [matchEmbed], components: [disabledRow] });

          // Immediate new queue initialization (timer removed)
          const queue = await getQuery('queues', { channel_id: channelId, guild_id: guildId });
          if (queue) {
            const membersWithRole = interaction.guild.members.cache.filter(member => member.roles.cache.has(queue.role_id));
            const players = [];
            for (const member of membersWithRole.values()) {
              const isRegistered = await getQuery('players', { user_id: member.id, guild_id: guildId });
              if (isRegistered) players.push(`<@${member.id}>`);
            }

            const queueTitle = queue.title || 'Matchmaking Queue';
            const newQueueEmbed = new EmbedBuilder()
              .setTitle(queueTitle)
              .setDescription(`**Players:**\n${players.length ? players.join('\n') : 'None'}\n\n**Count:** ${players.length}/10`)
              .setColor('#0099ff')
              .setFooter({ text: 'New queue started' })
              .setTimestamp();
            const newQueueMsg = await channel.send({ embeds: [newQueueEmbed] });
            await runQuery('settings', 'INSERT', null, { key: `queue_message_${channelId}`, value: newQueueMsg.id, guild_id: guildId })
              .catch(async (error) => {
                if (error.code === 11000) {
                  await runQuery('settings', 'UPDATE', { key: `queue_message_${channelId}`, guild_id: guildId }, { value: newQueueMsg.id });
                } else throw error;
              });
          }

          await interaction.deferUpdate();
        }

        if (customId === 'maps') {
          const newMap = await getRandomMap(guildId);
          const updatedEmbed = EmbedBuilder.from(matchEmbed)
            .setDescription(matchEmbed.description.replace(/\*\*Map:\*\* .*/, `**Map:** ${newMap}`));
          await interaction.message.edit({ embeds: [updatedEmbed] });
          await interaction.deferUpdate();
        }

        if (customId === 'teams') {
          const ctMatch = matchEmbed.description.match(/\*\*CT Team 1:\*\*\n([\s\S]*?)\n\n\*\*TR Team 2:/);
          const trMatch = matchEmbed.description.match(/\*\*TR Team 2:\*\*\n([\s\S]*?)\n\n\*\*Map:/);
          if (!ctMatch || !trMatch) throw new Error('Invalid team description format');

          const players = [
            ...ctMatch[1].split('\n').filter(line => line.trim()),
            ...trMatch[1].split('\n').filter(line => line.trim())
          ];
          const [newCtTeam, newTrTeam] = shuffleAndSplit(players);
          const mapMatch = matchEmbed.description.match(/\*\*Map:\*\* (.*)/);
          if (!mapMatch) throw new Error('Invalid map format in description');
          const mapLine = `**Map:** ${mapMatch[1]}`;
          const updatedEmbed = EmbedBuilder.from(matchEmbed)
            .setDescription(`**CT Team 1:**\n${newCtTeam.join('\n')}\n\n**TR Team 2:**\n${newTrTeam.join('\n')}\n\n${mapLine}`);
          await interaction.message.edit({ embeds: [updatedEmbed] });
          await interaction.deferUpdate();
        }
      } catch (error) {
        console.error(`Button handler error (${customId}):`, error);
        await interaction.reply({ content: 'An error occurred while processing this action!', flags: [64] });
      }
    }

    if (customId === 'reset_season_yes' || customId === 'reset_season_no') {
      if (!isMod) return interaction.reply({ content: 'Only moderators can confirm this action!', flags: [64] });

      await interaction.deferUpdate();

      const embed = interaction.message.embeds[0];
      const disabledRow = new ActionRowBuilder()
        .addComponents(
          new ButtonBuilder().setCustomId('reset_season_yes').setLabel('Yes').setStyle(ButtonStyle.Danger).setDisabled(true),
          new ButtonBuilder().setCustomId('reset_season_no').setLabel('No').setStyle(ButtonStyle.Secondary).setDisabled(true)
        );

      if (customId === 'reset_season_yes') {
        try {
          await runQuery('matches', 'DELETE', { guild_id: guildId });
          await db.collection('players').updateMany(
            { guild_id: guildId },
            { $set: { elo: 0, wins: 0, losses: 0, mvps: 0 } }
          );

          const rankRoles = await allQuery('ranks', { guild_id: guildId });
          const players = await allQuery('players', { guild_id: guildId });

          for (const player of players) {
            try {
              const member = interaction.guild.members.cache.get(player.user_id) || (await interaction.guild.members.fetch(player.user_id));
              if (member) {
                await member.roles.remove(rankRoles.map(r => r.role_id)).catch(err => console.error(`Failed to remove roles for user ${player.user_id}:`, err));
                try {
                  await member.setNickname(`0 | ${player.name}`);
                } catch (error) {
                  if (error.code === 50013) {
                    console.log(`Skipped nickname update for user ${player.user_id} due to missing permissions.`);
                  } else {
                    console.error(`Failed to update nickname for user ${player.user_id}:`, error);
                  }
                }
                await assignRankedRole(db, interaction.guild, player.user_id, 0);
              }
            } catch (error) {
              console.error(`Failed to process user ${player.user_id} during season reset:`, error);
            }
          }

          const updatedEmbed = EmbedBuilder.from(embed)
            .setDescription('Season has been reset successfully!\n- All matches have been cleared.\n- All player Elos and stats have been reset.')
            .setColor('#00ff00');
          await interaction.editReply({ embeds: [updatedEmbed], components: [disabledRow] });
        } catch (error) {
          console.error(`Error during season reset for guild ${guildId}:`, error);
          const errorEmbed = EmbedBuilder.from(embed)
            .setDescription('An error occurred while resetting the season. Please check the logs for details.')
            .setColor('#ff0000');
          await interaction.editReply({ embeds: [errorEmbed], components: [disabledRow] });
        }
      } else if (customId === 'reset_season_no') {
        const updatedEmbed = EmbedBuilder.from(embed)
          .setDescription('Season reset has been canceled.')
          .setColor('#ff0000');
        await interaction.editReply({ embeds: [updatedEmbed], components: [disabledRow] });
      }
    }
  }
});

// Guild member update (adapted for MongoDB)
client.on('guildMemberUpdate', async (oldMember, newMember) => {
  const guildId = newMember.guild.id;
  const db = await getDb();

  const queues = await allQuery('queues', { guild_id: guildId });
  for (const queue of queues) {
    const { channel_id, role_id, title } = queue;
    const channel = newMember.guild.channels.cache.get(channel_id);
    if (!channel) continue;

    const msgId = (await getQuery('settings', { key: `queue_message_${channel_id}`, guild_id: guildId }))?.value;
    if (!msgId) continue;

    const queueMsg = await channel.messages.fetch(msgId).catch(() => null);
    if (!queueMsg) continue;

    let embed = queueMsg.embeds[0];
    let players = embed.description.match(/\*\*Players:\*\*\n([\s\S]*?)\n\n\*\*Count:/)[1].split('\n').filter(p => p && p !== 'None');
    let count = players.length;

    const hadRole = oldMember.roles.cache.has(role_id);
    const hasRole = newMember.roles.cache.has(role_id);

    // Only proceed if the role change matches this queue's role_id
    if (!hadRole && hasRole) {
      if (players.includes(`<@${newMember.id}>`)) continue;
      if (count >= 10) continue;

      const isRegistered = await getQuery('players', { user_id: newMember.id, guild_id: guildId });
      if (!isRegistered) continue;

      players.push(`<@${newMember.id}>`);
      count++;
      embed = EmbedBuilder.from(embed)
        .setDescription(`**Players:**\n${players.join('\n')}\n\n**Count:** ${count}/10`)
        .setFooter({ text: `@${newMember.displayName} joined the queue` });

      // Edit the embed until 9/10, then repost at 9/10 or more
      if (count < 9) {
        await queueMsg.edit({ embeds: [embed] });
      } else if (count >= 9) {
        const newQueueMsg = await channel.send({ embeds: [embed] });
        await runQuery('settings', 'UPDATE', { key: `queue_message_${channel_id}`, guild_id: guildId }, { value: newQueueMsg.id })
          .catch(async (error) => {
            if (error.code === 11000) {
              await runQuery('settings', 'UPDATE', { key: `queue_message_${channel_id}`, guild_id: guildId }, { value: newQueueMsg.id });
            } else throw error;
          });
        // Delete the old message silently
        if (queueMsg.deletable) {
          await queueMsg.delete().catch(err => {
            if (err.code !== 10008) console.error(`Error deleting old queue message ${msgId}:`, err);
          });
        }
      }
    } else if (hadRole && !hasRole) {
      const index = players.indexOf(`<@${newMember.id}>`);
      if (index === -1) continue;

      players.splice(index, 1);
      count--;
      embed = EmbedBuilder.from(embed)
        .setDescription(`**Players:**\n${players.length ? players.join('\n') : 'None'}\n\n**Count:** ${count}/10`)
        .setFooter({ text: `@${newMember.displayName} left the queue` });
    } else {
      continue; // Skip if no relevant role change for this queue
    }

    // Handle the case where count reaches 10
    if (count === 10) {
      await queueMsg.edit({ embeds: [embed] });
      await createMatch(db, channel, players, guildId);
    }
  }
});

client.login(process.env.TOKEN);