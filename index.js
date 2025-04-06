const { Client, EmbedBuilder, SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const sqlite3 = require('sqlite3').verbose();
const config = require('./config.json');

const client = new Client({ intents: ['Guilds', 'GuildMessages', 'MessageContent', 'GuildMembers'] });

const getDb = (guildId) => {
  const db = new sqlite3.Database(`./maps_${guildId}.db`, (err) => {
    if (err) console.error(`Database error for guild ${guildId}:`, err);
    console.log(`Connected to SQLite database for guild ${guildId}.`);
  });

  db.serialize(() => {
    // Create all tables
    db.run(`CREATE TABLE IF NOT EXISTS maps (map_name TEXT UNIQUE, guild_id TEXT, PRIMARY KEY (map_name, guild_id))`);
    db.run(`CREATE TABLE IF NOT EXISTS players (user_id TEXT, name TEXT UNIQUE, elo INTEGER DEFAULT 0, wins INTEGER DEFAULT 0, losses INTEGER DEFAULT 0, mvps INTEGER DEFAULT 0, guild_id TEXT, PRIMARY KEY (user_id, guild_id))`);
    db.run(`CREATE TABLE IF NOT EXISTS settings (key TEXT, value TEXT, guild_id TEXT, PRIMARY KEY (key, guild_id))`);
    db.run(`CREATE TABLE IF NOT EXISTS ranks (role_id TEXT, start_elo INTEGER, win_elo INTEGER, loss_elo INTEGER, mvp_elo INTEGER, guild_id TEXT, PRIMARY KEY (role_id, guild_id))`);
    db.run(`CREATE TABLE IF NOT EXISTS matches (match_number INTEGER, ct_team TEXT, tr_team TEXT, map TEXT, guild_id TEXT, scored INTEGER DEFAULT 0, PRIMARY KEY (match_number, guild_id))`);
    db.run(`CREATE TABLE IF NOT EXISTS queues (channel_id TEXT, guild_id TEXT, title TEXT, PRIMARY KEY (channel_id, guild_id))`);

    // Check and update queues table schema
    db.all(`PRAGMA table_info(queues)`, (err, rows) => {
      if (err) {
        console.error('Error checking queues schema:', err);
        return;
      }
      const columns = rows || []; // Default to empty array if undefined
      const hasTitle = columns.some(row => row.name === 'title');
      if (!hasTitle) {
        db.run(`ALTER TABLE queues ADD COLUMN title TEXT`, err => {
          if (err) console.error('Error adding title column to queues:', err);
          else console.log('Added title column to queues table');
        });
      }
    });
  });

  return db;
};

const assignRankedRole = async (db, guild, userId, elo) => {
  const ranks = await new Promise((resolve, reject) => {
    db.all(`SELECT role_id, start_elo FROM ranks WHERE guild_id = ? ORDER BY start_elo DESC`, [guild.id], (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
  const member = guild.members.cache.get(userId);
  const currentRoles = member.roles.cache.filter(role => ranks.some(rank => rank.role_id === role.id));
  currentRoles.forEach(role => member.roles.remove(role.id).catch(console.error));
  const applicableRank = ranks.find(rank => elo >= rank.start_elo);
  if (applicableRank) {
    member.roles.add(applicableRank.role_id).catch(console.error);
  }
};

const getNextMatchNumber = (db, guildId) => new Promise(resolve => {
  db.get(`SELECT MAX(match_number) as max FROM matches WHERE guild_id = ?`, [guildId], (err, row) => {
    resolve((row?.max || 0) + 1);
  });
});

const shuffleAndSplit = (players) => {
  const shuffled = [...players].sort(() => Math.random() - 0.5);
  return [shuffled.slice(0, 5), shuffled.slice(5)];
};

const getRandomMap = (db, guildId) => new Promise(resolve => {
  db.all(`SELECT map_name FROM maps WHERE guild_id = ?`, [guildId], (err, rows) => {
    if (err || rows.length === 0) resolve('No maps available');
    else resolve(rows[Math.floor(Math.random() * rows.length)].map_name);
  });
});

const updatePlayerEloAndRank = async (db, guild, userId, eloChange, isMvp, bonus, channelId) => {
  return new Promise((resolve) => {
    db.get(`SELECT elo, name FROM players WHERE user_id = ? AND guild_id = ?`, [userId, guild.id], async (err, row) => {
      if (err || !row) return resolve({ oldElo: 0, newElo: 0, name: 'Unknown' });
      const oldElo = row.elo;
      let newElo = Math.max(0, oldElo + eloChange); // Prevent negative Elo
      if (isMvp) {
        const mvpElo = await new Promise(resolve => {
          db.get(`SELECT mvp_elo FROM ranks WHERE start_elo <= ? AND guild_id = ? ORDER BY start_elo DESC LIMIT 1`, [oldElo, guild.id], (err, row) => resolve(row?.mvp_elo || 0));
        });
        newElo += mvpElo;
      }
      newElo += bonus;
      db.run(`UPDATE players SET elo = ? WHERE user_id = ? AND guild_id = ?`, [newElo, userId, guild.id]);

      const oldRank = await new Promise(resolve => {
        db.get(`SELECT role_id FROM ranks WHERE start_elo <= ? AND guild_id = ? ORDER BY start_elo DESC LIMIT 1`, [oldElo, guild.id], (err, row) => resolve(row?.role_id));
      });
      await assignRankedRole(db, guild, userId, newElo);
      const newRank = await new Promise(resolve => {
        db.get(`SELECT role_id FROM ranks WHERE start_elo <= ? AND guild_id = ? ORDER BY start_elo DESC LIMIT 1`, [newElo, guild.id], (err, row) => resolve(row?.role_id));
      });

      if (oldRank !== newRank && channelId) {
        const updatesChannel = guild.channels.cache.get(channelId);
        if (updatesChannel) {
          const embed = new EmbedBuilder()
            .setColor(newElo > oldElo ? '#00ff00' : '#ff0000')
            .setDescription(newElo > oldElo ? `@${row.name} has ranked up to <@&${newRank}>` : `@${row.name} has deranked to <@&${newRank}>`);
          updatesChannel.send({ embeds: [embed] });
        }
      }
      resolve({ oldElo, newElo, name: row.name });
    });
  });
};

const createMatch = async (db, channel, players, guildId) => {
  const matchNumber = await getNextMatchNumber(db, guildId);
  const [ctTeam, trTeam] = shuffleAndSplit(players);
  const map = await getRandomMap(db, guildId);
  const matchEmbed = new EmbedBuilder()
    .setTitle(`Match #${matchNumber}`)
    .setDescription(`**CT Team 1:**\n${ctTeam.join('\n')}\n\n**TR Team 2:**\n${trTeam.join('\n')}\n\n**Map:** ${map}`)
    .setColor('#00ff00')
    .setTimestamp();
  const row = new ActionRowBuilder()
    .addComponents(
      new ButtonBuilder().setCustomId('next_match').setLabel('Next').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('maps').setLabel('Maps').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('teams').setLabel('Teams').setStyle(ButtonStyle.Primary)
    );
  await channel.send({ embeds: [matchEmbed], components: [row] });

  const queueMsgId = await new Promise(resolve => {
    db.get(`SELECT value FROM settings WHERE key = ? AND guild_id = ?`, [`queue_message_${channel.id}`, guildId], (err, row) => resolve(row?.value));
  });
  const queueMsg = await channel.messages.fetch(queueMsgId);
  const resetEmbed = EmbedBuilder.from(queueMsg.embeds[0])
    .setDescription(`**Players:**\nNone\n\n**Count:** 0/10`)
    .setFooter({ text: 'Match created, queue reset' });
  await queueMsg.edit({ embeds: [resetEmbed] });
};

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
    .addChannelOption(option => option.setName('channel_id').setDescription('The channel for matchmaking').setRequired(true))
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
].map(command => command.toJSON());

client.once('ready', async () => {
  console.log('Bot is online!');
  try {
    await client.application.commands.set(commands);
    console.log('Slash commands registered!');
  } catch (error) {
    console.error('Error registering commands:', error);
  }
});

client.on('interactionCreate', async (interaction) => {
  const db = getDb(interaction.guildId);
  const getModRole = () => new Promise((resolve) => {
    db.get(`SELECT value FROM settings WHERE key = 'mod_role' AND guild_id = ?`, [interaction.guildId], (err, row) => {
      resolve(row ? row.value : null);
    });
  });
  const modRoleId = await getModRole();
  const isMod = modRoleId && interaction.member.roles.cache.has(modRoleId);
  const updatesChannelId = await new Promise(resolve => {
    db.get(`SELECT value FROM settings WHERE key = 'updates_channel' AND guild_id = ?`, [interaction.guildId], (err, row) => resolve(row?.value));
  });

  if (interaction.isCommand()) {
    const { commandName, options } = interaction;

    if (commandName === 'force_register') {
      if (!avançadoisMod) return interaction.reply('Only moderators can use this command!');
      const targetUser = options.getUser('user');
      const playerName = options.getString('player_name');
      const userId = targetUser.id;
      db.get(`SELECT name FROM players WHERE user_id = ? AND guild_id = ?`, [userId, interaction.guildId], (err, row) => {
        if (err) return interaction.reply('Error checking registration!');
        if (row) return interaction.reply('This user is already registered!');
        db.run(`INSERT INTO players (user_id, name, elo, wins, losses, mvps, guild_id) VALUES (?, ?, 0, 0, 0, 0, ?)`,
          [userId, playerName, interaction.guildId], (err) => {
            if (err) return interaction.reply('Error force registering player!');
            const registeredRoleIdPromise = new Promise((resolve) => {
              db.get(`SELECT value FROM settings WHERE key = 'registered_role' AND guild_id = ?`, [interaction.guildId], (err, row) => resolve(row ? row.value : null));
            });
            registeredRoleIdPromise.then(async (registeredRoleId) => {
              const member = interaction.guild.members.cache.get(userId);
              if (registeredRoleId) member.roles.add(registeredRoleId).catch(console.error);
              await assignRankedRole(db, interaction.guild, userId, 0);
              member.setNickname(`0 | ${playerName}`).catch(console.error);
              const embed = new EmbedBuilder()
                .setTitle('Player Force Registered')
                .setDescription(`<@${userId}> has been registered as "${playerName}"!`)
                .setColor('#00ff00');
              interaction.reply({ embeds: [embed] });
            });
          });
      });
    }

    if (commandName === 'force_rename') {
      if (!isMod) return interaction.reply('Only moderators can use this command!');
      const targetUser = options.getUser('user');
      const newName = options.getString('new_name');
      const userId = targetUser.id;
      db.get(`SELECT name, elo FROM players WHERE user_id = ? AND guild_id = ?`, [userId, interaction.guildId], (err, row) => {
        if (err) return interaction.reply('Error checking player!');
        if (!row) return interaction.reply(`User <@${userId}> is not registered!`);
        const oldName = row.name;
        const newNickname = `${row.elo} | ${newName}`;
        db.run(`UPDATE players SET name = ? WHERE user_id = ? AND guild_id = ?`, [newName, userId, interaction.guildId], (err) => {
          if (err) return interaction.reply('Error renaming player!');
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
        });
      });
    }

    if (commandName === 'unregister') {
      if (!isMod) return interaction.reply('Only moderators can use this command!');
      const targetUser = options.getUser('user');
      const userId = targetUser.id;
      db.get(`SELECT name FROM players WHERE user_id = ? AND guild_id = ?`, [userId, interaction.guildId], (err, row) => {
        if (err) return interaction.reply('Error checking player!');
        if (!row) return interaction.reply(`User <@${userId}> is not registered!`);
        const playerName = row.name;
        db.run(`DELETE FROM players WHERE user_id = ? AND guild_id = ?`, [userId, interaction.guildId], async (err) => {
          if (err) return interaction.reply('Error unregistering player!');
          const member = interaction.guild.members.cache.get(userId);
          member.setNickname(null).catch(console.error);

          // Remove registered role
          const registeredRoleId = await new Promise((resolve) => {
            db.get(`SELECT value FROM settings WHERE key = 'registered_role' AND guild_id = ?`, [interaction.guildId], (err, row) => resolve(row ? row.value : null));
          });
          if (registeredRoleId) member.roles.remove(registeredRoleId).catch(console.error);

          // Remove all rank roles
          const rankRoles = await new Promise((resolve) => {
            db.all(`SELECT role_id FROM ranks WHERE guild_id = ?`, [interaction.guildId], (err, rows) => resolve(rows.map(row => row.role_id)));
          });
          rankRoles.forEach(roleId => member.roles.remove(roleId).catch(console.error));

          const embed = new EmbedBuilder()
            .setTitle('Player Unregistered')
            .setDescription(`"${playerName}" (<@${userId}>) has been unregistered!`)
            .setColor('#ff0000');
          interaction.reply({ embeds: [embed] });
        });
      });
    }

    if (commandName === 'stats') {
      const targetUser = options.getUser('user') || interaction.user;
      const userId = targetUser.id;
      db.get(`SELECT * FROM players WHERE user_id = ? AND guild_id = ?`, [userId, interaction.guildId], async (err, row) => {
        if (err) return interaction.reply('Error fetching stats!');
        if (!row) return interaction.reply('This user is not registered!');

        const ranks = await new Promise((resolve) => {
          db.all(`SELECT role_id, start_elo FROM ranks WHERE guild_id = ? ORDER BY start_elo DESC`, [interaction.guildId], (err, rows) => resolve(rows));
        });
        const rankRole = ranks.find(rank => row.elo >= rank.start_elo);
        const rankTitle = rankRole ? `<@&${rankRole.role_id}>` : 'Unranked';
        const matchesPlayed = row.wins + row.losses;
        const winLossRatio = matchesPlayed > 0 ? (row.wins / matchesPlayed).toFixed(2) : 'N/A';

        const embed = new EmbedBuilder()
          .setTitle(`${row.name}'s Stats`)
          .setDescription([
            `**Name:** ${row.name}`,
            `**Rank:** ${rankTitle}`,
            `**Wins:** ${row.wins}`,
            `**Losses:** ${row.losses}`,
            `**MVPs:** ${row.mvps}`,
            `**Elo:** ${row.elo}`,
            `**Matches Played:** ${matchesPlayed}`,
            `**Win/Loss Ratio:** ${winLossRatio}`
          ].join('\n'))
          .setColor('#0099ff')
          .setTimestamp();
        interaction.reply({ embeds: [embed] });
      });
    }

    if (commandName === 'score') {
      if (!isMod) return interaction.reply({ content: 'Only moderators can use this command!', ephemeral: true });
      const matchId = options.getInteger('match_id');
      const winnerTeam = options.getInteger('winner_team');
      const mvp1 = options.getUser('mvp1');
      const mvp2 = options.getUser('mvp2');
      if (winnerTeam !== 1 && winnerTeam !== 2) return interaction.reply('Winner team must be 1 or 2!');

      db.get(`SELECT ct_team, tr_team, scored, guild_id FROM matches WHERE match_number = ? AND guild_id = ?`, [matchId, interaction.guildId], async (err, row) => {
        if (err || !row) return interaction.reply(`Match #${matchId} not found!`);
        if (row.scored) return interaction.reply(`Match #${matchId} has already been scored!`);

        const ctTeam = row.ct_team.split(',').map(id => id.trim());
        const trTeam = row.tr_team.split(',').map(id => id.trim());
        const winningTeam = winnerTeam === 1 ? ctTeam : trTeam;
        const losingTeam = winnerTeam === 1 ? trTeam : ctTeam;

        const bonus = await new Promise(resolve => {
          db.get(`SELECT value FROM settings WHERE key = ? AND guild_id = ?`, [`queue_bonus_${interaction.channelId}`, interaction.guildId], (err, row) => resolve(parseInt(row?.value) || 0));
        });

        const eloChanges = [];
        for (const userId of winningTeam) {
          const rank = await new Promise(resolve => {
            db.get(`SELECT win_elo FROM ranks WHERE start_elo <= (SELECT elo FROM players WHERE user_id = ? AND guild_id = ?) AND guild_id = ? ORDER BY start_elo DESC LIMIT 1`, [userId, interaction.guildId, interaction.guildId], (err, row) => resolve(row));
          });
          const winElo = rank?.win_elo || 0;
          const isMvp = (userId === mvp1?.id || userId === mvp2?.id);
          const { oldElo, newElo, name } = await updatePlayerEloAndRank(db, interaction.guild, userId, winElo, isMvp, bonus, updatesChannelId);
          eloChanges.push(`[${oldElo}] -> [${newElo}] ${name}`);
        }
        for (const userId of losingTeam) {
          const rank = await new Promise(resolve => {
            db.get(`SELECT loss_elo FROM ranks WHERE start_elo <= (SELECT elo FROM players WHERE user_id = ? AND guild_id = ?) AND guild_id = ? ORDER BY start_elo DESC LIMIT 1`, [userId, interaction.guildId, interaction.guildId], (err, row) => resolve(row));
          });
          const lossElo = -(rank?.loss_elo || 0);
          const isMvp = (userId === mvp1?.id || userId === mvp2?.id);
          const { oldElo, newElo, name } = await updatePlayerEloAndRank(db, interaction.guild, userId, lossElo, isMvp, 0, updatesChannelId);
          eloChanges.push(`[${oldElo}] -> [${newElo}] ${name}`);
        }

        db.run(`UPDATE matches SET scored = 1 WHERE match_number = ? AND guild_id = ?`, [matchId, interaction.guildId]);
        const embed = new EmbedBuilder()
          .setTitle(`Match #${matchId} Results`)
          .setDescription(eloChanges.join('\n'))
          .setColor('#00ff00')
          .setFooter({ text: `Match #${matchId} has been scored` });
        interaction.reply({ embeds: [embed] });
      });
    }

    if (commandName === 'sub') {
      if (!isMod) return interaction.reply({ content: 'Only moderators can use this command!', ephemeral: true });
      const matchId = options.getInteger('match_id');
      const oldPlayer = options.getUser('old_player');
      const newPlayer = options.getUser('new_player');

      db.get(`SELECT ct_team, tr_team, map, scored FROM matches WHERE match_number = ? AND guild_id = ?`, [matchId, interaction.guildId], async (err, row) => {
        if (err || !row) return interaction.reply(`Match #${matchId} not found!`);
        if (row.scored) return interaction.reply(`Match #${matchId} has already been scored and cannot be modified!`);

        let ctTeam = row.ct_team.split(',');
        let trTeam = row.tr_team.split(',');
        const allPlayers = [...ctTeam, ...trTeam];
        if (!allPlayers.includes(oldPlayer.id)) return interaction.reply(`<@${oldPlayer.id}> is not in Match #${matchId}!`);
        if (allPlayers.includes(newPlayer.id)) return interaction.reply(`<@${newPlayer.id}> is already in Match #${matchId}!`);

        if (ctTeam.includes(oldPlayer.id)) {
          ctTeam[ctTeam.indexOf(oldPlayer.id)] = newPlayer.id;
        } else {
          trTeam[trTeam.indexOf(oldPlayer.id)] = newPlayer.id;
        }

        db.run(`UPDATE matches SET ct_team = ?, tr_team = ? WHERE match_number = ? AND guild_id = ?`, [ctTeam.join(','), trTeam.join(','), matchId, interaction.guildId]);
        const embed = new EmbedBuilder()
          .setTitle(`Match #${matchId}`)
          .setDescription(`**CT Team 1:**\n${ctTeam.map(id => `<@${id}>`).join('\n')}\n\n**TR Team 2:**\n${trTeam.map(id => `<@${id}>`).join('\n')}\n\n**Map:** ${row.map}`)
          .setColor('#00ff00')
          .setTimestamp();
        interaction.reply({ embeds: [embed] });
      });
    }

    if (commandName === 'undo') {
      if (!isMod) return interaction.reply({ content: 'Only moderators can use this command!', ephemeral: true });
      const matchId = options.getInteger('match_id');

      db.get(`SELECT ct_team, tr_team, scored FROM matches WHERE match_number = ? AND guild_id = ?`, [matchId, interaction.guildId], async (err, row) => {
        if (err || !row) return interaction.reply(`Match #${matchId} not found!`);
        if (!row.scored) return interaction.reply(`Match #${matchId} has not been scored yet!`);

        const ctTeam = row.ct_team.split(',');
        const trTeam = row.tr_team.split(',');
        const allPlayers = [...ctTeam, ...trTeam];
        const eloChanges = [];

        for (const userId of allPlayers) {
          db.get(`SELECT elo, name FROM players WHERE user_id = ? AND guild_id = ?`, [userId, interaction.guildId], async (err, player) => {
            if (err || !player) return;
            const oldElo = player.elo;
            const originalElo = await new Promise(resolve => {
              db.get(`SELECT elo FROM players WHERE user_id = ? AND guild_id = ?`, [userId, interaction.guildId], (err, row) => resolve(row?.elo || 0));
            });
            db.run(`UPDATE players SET elo = ? WHERE user_id = ? AND guild_id = ?`, [originalElo, userId, interaction.guildId]);
            await assignRankedRole(db, interaction.guild, userId, originalElo);
            eloChanges.push(`[${oldElo}] -> [${originalElo}] ${player.name}`);
          });
        }

        db.run(`UPDATE matches SET scored = 0 WHERE match_number = ? AND guild_id = ?`, [matchId, interaction.guildId]);
        const embed = new EmbedBuilder()
          .setTitle(`Match #${matchId} Undo`)
          .setDescription(eloChanges.join('\n'))
          .setColor('#ff0000')
          .setFooter({ text: `Match #${matchId} scoring has been undone` });
        interaction.reply({ embeds: [embed] });
      });
    }

    if (commandName === 'set_updates_channel') {
      if (!isMod) return interaction.reply({ content: 'Only moderators can use this command!', ephemeral: true });
      const channel = options.getChannel('channel_id');
      if (channel.type !== 0) return interaction.reply('Please select a text channel!');
      db.run(`INSERT OR REPLACE INTO settings (key, value, guild_id) VALUES ('updates_channel', ?, ?)`, [channel.id, interaction.guildId], err => {
        if (err) return interaction.reply('Error setting updates channel!');
        interaction.reply(`Updates channel set to <#${channel.id}>!`);
      });
    }

    if (commandName === 'leaderboard') {
      db.all(`SELECT name, elo FROM players WHERE guild_id = ? ORDER BY elo DESC LIMIT 10`, [interaction.guildId], (err, rows) => {
        if (err) return interaction.reply('Error fetching leaderboard!');
        const leaderboard = rows.length > 0
          ? rows.map((row, index) => `${index + 1}. ${row.elo} | ${row.name}`).join('\n')
          : 'No players registered yet.';
        const embed = new EmbedBuilder()
          .setTitle('Leaderboard - Top 10 Players')
          .setDescription(leaderboard)
          .setColor('#FFD700')
          .setFooter({ text: `Total Players: ${rows.length}` })
          .setTimestamp();
        interaction.reply({ embeds: [embed] });
      });
    }

    if (commandName === 'add_rank') {
      if (!isMod) return interaction.reply('Only moderators can use this command!');
      const role = options.getRole('role');
      const startElo = options.getInteger('start');
      const winElo = options.getInteger('win');
      const lossElo = options.getInteger('loss');
      const mvpElo = options.getInteger('mvp');
      db.run(`INSERT OR REPLACE INTO ranks (role_id, start_elo, win_elo, loss_elo, mvp_elo, guild_id) VALUES (?, ?, ?, ?, ?, ?)`,
        [role.id, startElo, winElo, lossElo, mvpElo, interaction.guildId], (err) => {
          if (err) return interaction.reply('Error adding rank!');
          const embed = new EmbedBuilder()
            .setTitle('Rank Added')
            .setDescription(`Rank <@&${role.id}> added with Start: ${startElo}, Win: +${winElo}, Loss: -${lossElo}, MVP: +${mvpElo}`)
            .setColor('#00ff00');
          interaction.reply({ embeds: [embed] });
        });
    }

    if (commandName === 'ranks') {
      db.all(`SELECT * FROM ranks WHERE guild_id = ?`, [interaction.guildId], (err, rows) => {
        if (err) return interaction.reply('Error fetching ranks!');
        const sortedRows = rows.sort((a, b) => a.start_elo - b.start_elo);
        const rankList = sortedRows.length > 0
          ? sortedRows.map(row => `<@&${row.role_id}> ST: ${row.start_elo} W:(+${row.win_elo}) L:(-${row.loss_elo}) MVP:(+${row.mvp_elo})`).join('\n')
          : 'No ranks defined.';
        const embed = new EmbedBuilder()
          .setTitle('Rank List')
          .setDescription(rankList)
          .setColor('#0099ff')
          .setFooter({ text: `Total Ranks: ${sortedRows.length}` })
          .setTimestamp();
        interaction.reply({ embeds: [embed] });
      });
    }

    if (commandName === 'remove_rank') {
      if (!isMod) return interaction.reply('Only moderators can use this command!');
      const role = options.getRole('role');
      db.get(`SELECT role_id FROM ranks WHERE role_id = ? AND guild_id = ?`, [role.id, interaction.guildId], (err, row) => {
        if (err) return interaction.reply('Error checking rank!');
        if (!row) return interaction.reply(`Rank for <@&${role.id}> not found!`);
        db.run(`DELETE FROM ranks WHERE role_id = ? AND guild_id = ?`, [role.id, interaction.guildId], (err) => {
          if (err) return interaction.reply('Error removing rank!');
          const embed = new EmbedBuilder()
            .setTitle('Rank Removed')
            .setDescription(`Rank <@&${role.id}> removed successfully!`)
            .setColor('#ff0000');
          interaction.reply({ embeds: [embed] });
        });
      });
    }

    if (commandName === 'register') {
      const getRegisterChannel = () => new Promise((resolve) => {
        db.get(`SELECT value FROM settings WHERE key = 'register_channel' AND guild_id = ?`, [interaction.guildId], (err, row) => {
          resolve(row ? row.value : null);
        });
      });
      const registerChannelId = await getRegisterChannel();
      if (registerChannelId && interaction.channelId !== registerChannelId) {
        return interaction.reply(`Please use this command in <@${registerChannelId}>!`);
      }

      const playerName = options.getString('player_name');
      const userId = interaction.user.id;
      const member = interaction.member;

      // Fetch the registered role ID
      const registeredRoleId = await new Promise((resolve) => {
        db.get(`SELECT value FROM settings WHERE key = 'registered_role' AND guild_id = ?`, [interaction.guildId], (err, row) => resolve(row ? row.value : null));
      });

      // Check if user has the Registered role
      const hasRegisteredRole = registeredRoleId && member.roles.cache.has(registeredRoleId);

      db.get(`SELECT name, elo FROM players WHERE user_id = ? AND guild_id = ?`, [userId, interaction.guildId], async (err, dbRow) => {
        if (err) return interaction.reply('Error checking registration!');

        // If user has the Registered role and is in the database, they’re fully registered
        if (hasRegisteredRole && dbRow) {
          return interaction.reply('You are already registered!');
        }

        // If user is in the database but doesn’t have the Registered role, request re-approval
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

        // If user is not in the database, proceed with new registration
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
    }

    if (commandName === 'rename') {
      const newName = options.getString('new_name');
      const userId = interaction.user.id;
      db.get(`SELECT name, elo FROM players WHERE user_id = ? AND guild_id = ?`, [userId, interaction.guildId], (err, row) => {
        if (err) return interaction.reply('Error checking player!');
        if (!row) return interaction.reply('You are not registered yet!');
        const newNickname = `${row.elo} | ${newName}`;
        db.run(`UPDATE players SET name = ? WHERE user_id = ? AND guild_id = ?`, [newName, userId, interaction.guildId], (err) => {
          if (err) return interaction.reply('Error updating name!');
          interaction.member.setNickname(newNickname)
            .then(() => interaction.reply(`Your name has been updated to "${newNickname}"!`))
            .catch(() => interaction.reply('Name updated in database, but I couldn’t change your nickname (check my permissions)!'));
        });
      });
    }

    if (commandName === 'set_register_channel') {
      if (!isMod) return interaction.reply('Only moderators can use this command!');
      const channel = options.getChannel('channel_id');
      if (channel.type !== 0) return interaction.reply('Please select a text channel!');
      db.run(`INSERT OR REPLACE INTO settings (key, value, guild_id) VALUES ('register_channel', ?, ?)`, [channel.id, interaction.guildId], (err) => {
        if (err) return interaction.reply('Error setting register channel!');
        interaction.reply(`Registration channel set to <#${channel.id}>!`);
      });
    }

    if (commandName === 'set_registered_role') {
      if (!isMod) return interaction.reply('Only moderators can use this command!');
      const role = options.getRole('role');
      db.run(`INSERT OR REPLACE INTO settings (key, value, guild_id) VALUES ('registered_role', ?, ?)`, [role.id, interaction.guildId], (err) => {
        if (err) return interaction.reply('Error setting registered role!');
        interaction.reply(`Registered role set to <@&${role.id}>!`);
      });
    }

    if (commandName === 'set_mod_role') {
      if (!isMod && !interaction.member.permissions.has('Administrator')) return interaction.reply('Only moderators or admins can use this command!');
      const role = options.getRole('role');
      db.run(`INSERT OR REPLACE INTO settings (key, value, guild_id) VALUES ('mod_role', ?, ?)`, [role.id, interaction.guildId], (err) => {
        if (err) return interaction.reply('Error setting mod role!');
        interaction.reply(`Moderator role set to <@&${role.id}>!`);
      });
    }

    if (commandName === 'add_map') {
      const mapName = options.getString('map_name');
      db.run(`INSERT OR IGNORE INTO maps (map_name, guild_id) VALUES (?, ?)`, [mapName, interaction.guildId], (err) => {
        if (err) return interaction.reply('Error adding map!');
        interaction.reply(`Map "${mapName}" added successfully!`);
      });
    }

    if (commandName === 'remove_map') {
      const mapName = options.getString('map_name');
      db.get(`SELECT map_name FROM maps WHERE map_name = ? AND guild_id = ?`, [mapName, interaction.guildId], (err, row) => {
        if (err) return interaction.reply('Error checking map!');
        if (!row) return interaction.reply(`Map "${mapName}" not found!`);
        db.run(`DELETE FROM maps WHERE map_name = ? AND guild_id = ?`, [mapName, interaction.guildId], (err) => {
          if (err) return interaction.reply('Error removing map!');
          interaction.reply(`Map "${mapName}" removed successfully!`);
        });
      });
    }

    if (commandName === 'maps') {
      db.all(`SELECT map_name FROM maps WHERE guild_id = ?`, [interaction.guildId], (err, rows) => {
        if (err) return interaction.reply('Error fetching maps!');
        const mapList = rows.map(row => row.map_name).join('\n') || 'No maps found.';
        const embed = new EmbedBuilder()
          .setTitle('Map List')
          .setDescription(mapList)
          .setColor('#0099ff')
          .setFooter({ text: `Total Maps: ${rows.length}` })
          .setTimestamp();
        interaction.reply({ embeds: [embed] });
      });
    }

    if (commandName === 'add_queue') {
      if (!isMod) return interaction.reply('Only moderators can use this command!');
      const channel = options.getChannel('channel_id');
      const title = options.getString('title') || 'Matchmaking Queue';
      const bonus = options.getInteger('bonus') || 0;
      if (channel.type !== 0) return interaction.reply('Please select a text channel!');

      try {
        await new Promise((resolve, reject) => {
          db.run(`INSERT OR IGNORE INTO queues (channel_id, guild_id, title) VALUES (?, ?, ?)`, [channel.id, interaction.guildId, title], err => {
            if (err) {
              console.error('Error inserting into queues:', err);
              reject(err);
            } else {
              resolve();
            }
          });
        });

        const embed = new EmbedBuilder()
          .setTitle(title)
          .setDescription('**Players:**\nNone\n\n**Count:** 0/10')
          .setColor('#0099ff')
          .setFooter({ text: 'Queue initialized' })
          .setTimestamp();
        const row = new ActionRowBuilder()
          .addComponents(
            new ButtonBuilder().setCustomId('join_queue').setLabel('Join').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId('leave_queue').setLabel('Leave').setStyle(ButtonStyle.Danger),
            new ButtonBuilder().setCustomId('clear_queue').setLabel('Clear').setStyle(ButtonStyle.Secondary)
          );
        const msg = await channel.send({ embeds: [embed], components: [row] });
        await new Promise(resolve => {
          db.run(`INSERT OR REPLACE INTO settings (key, value, guild_id) VALUES (?, ?, ?)`, [`queue_message_${channel.id}`, msg.id, interaction.guildId], err => {
            if (err) console.error('Error setting queue message ID:', err);
            resolve();
          });
        });
        await new Promise(resolve => {
          db.run(`INSERT OR REPLACE INTO settings (key, value, guild_id) VALUES (?, ?, ?)`, [`queue_bonus_${channel.id}`, bonus, interaction.guildId], err => {
            if (err) console.error('Error setting queue bonus:', err);
            resolve();
          });
        });
        interaction.reply(`Queue channel set to <#${channel.id}>!`);
      } catch (error) {
        interaction.reply('Error adding queue channel!');
        console.error('Add queue error:', error);
      }
    }

    if (commandName === 'remove_queue') {
      if (!isMod) return interaction.reply('Only moderators can use this command!');
      const channel = options.getChannel('channel_id');
      db.get(`SELECT channel_id FROM queues WHERE channel_id = ? AND guild_id = ?`, [channel.id, interaction.guildId], async (err, row) => {
        if (err || !row) return interaction.reply(`<#${channel.id}> is not a queue channel!`);

        // Fetch and delete the queue embed message
        const msgId = await new Promise(resolve => {
          db.get(`SELECT value FROM settings WHERE key = ? AND guild_id = ?`, [`queue_message_${channel.id}`, interaction.guildId], (err, row) => resolve(row?.value));
        });
        if (msgId) {
          const queueMsg = await channel.messages.fetch(msgId).catch(() => null);
          if (queueMsg) await queueMsg.delete();
        }

        // Remove queue from database and settings
        db.run(`DELETE FROM queues WHERE channel_id = ? AND guild_id = ?`, [channel.id, interaction.guildId], err => {
          if (err) return interaction.reply('Error removing queue channel!');
          db.run(`DELETE FROM settings WHERE key = ? AND guild_id = ?`, [`queue_message_${channel.id}`, interaction.guildId], err => {
            if (err) console.error('Error removing queue message ID from settings:', err);
            interaction.reply(`Queue channel <#${channel.id}> removed!`);
          });
        });
      });
    }

    if (commandName === 'queues') {
      db.all(`SELECT channel_id FROM queues WHERE guild_id = ?`, [interaction.guildId], (err, rows) => {
        if (err) return interaction.reply('Error fetching queues!');
        const queueList = rows.map(row => `<#${row.channel_id}>`).join('\n') || 'No queue channels set.';
        const embed = new EmbedBuilder()
          .setTitle('Queue Channels')
          .setDescription(queueList)
          .setColor('#0099ff')
          .setTimestamp();
        interaction.reply({ embeds: [embed] });
      });
    }

    if (commandName === 'set_results_channel') {
      if (!isMod) return interaction.reply('Only moderators can use this command!');
      const channel = options.getChannel('channel_id');
      if (channel.type !== 0) return interaction.reply('Please select a text channel!');
      db.run(`INSERT OR REPLACE INTO settings (key, value, guild_id) VALUES ('results_channel', ?, ?)`, [channel.id, interaction.guildId], err => {
        if (err) return interaction.reply('Error setting results channel!');
        interaction.reply(`Results channel set to <#${channel.id}>!`);
      });
    }
  }

  if (interaction.isButton()) {
    const { customId, user, guildId, channelId } = interaction;

    if (customId.startsWith('approve_') || customId.startsWith('decline_') || customId.startsWith('help_')) {
      const [action, userId] = customId.split('_');
      if (!isMod && (action === 'approve' || action === 'decline')) {
        return interaction.reply({ content: 'Only moderators can approve/decline registrations!', ephemeral: true });
      }
      if (!isMod && action === 'help') {
        return interaction.reply('Please include a screenshot of your common statistics (with hours)');
      }

      const embed = interaction.message.embeds[0];
      const playerName = embed.footer?.text.split(': ')[1].split(' | ')[0]; // Extract name before any " | Re-registration"

      if (action === 'approve') {
        if (!playerName) return interaction.reply('Error: Player name not found in request!');
        db.get(`SELECT name, elo FROM players WHERE user_id = ? AND guild_id = ?`, [userId, guildId], async (err, dbRow) => {
          if (err) return interaction.reply('Error checking player!');

          const member = interaction.guild.members.cache.get(userId);
          const registeredRoleId = await new Promise((resolve) => {
            db.get(`SELECT value FROM settings WHERE key = 'registered_role' AND guild_id = ?`, [guildId], (err, row) => resolve(row ? row.value : null));
          });

          if (dbRow) {
            // Re-registration: Update name if changed and reassign roles
            if (dbRow.name !== playerName) {
              db.run(`UPDATE players SET name = ? WHERE user_id = ? AND guild_id = ?`, [playerName, userId, guildId], (err) => {
                if (err) console.error('Error updating player name:', err);
              });
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
            // New registration
            db.run(`INSERT INTO players (user_id, name, elo, wins, losses, mvps, guild_id) VALUES (?, ?, 0, 0, 0, 0, ?)`,
              [userId, playerName, guildId], async (err) => {
                if (err) return interaction.reply('Error registering player!');
                if (registeredRoleId) member.roles.add(registeredRoleId).catch(console.error);
                await assignRankedRole(db, interaction.guild, userId, 0);
                member.setNickname(`0 | ${playerName}`).catch(console.error);
                const updatedEmbed = EmbedBuilder.from(embed)
                  .setDescription(`<@${userId}> registration approved!`)
                  .setColor('#00ff00')
                  .setFooter({ text: `Registered as: ${playerName}` });
                await interaction.update({ embeds: [updatedEmbed], components: [] });
              });
          }
        });
      } else if (action === 'decline') {
        const updatedEmbed = EmbedBuilder.from(embed)
          .setDescription(`<@${userId}> registration declined!`)
          .setColor('#ff0000')
          .setFooter({ text: embed.footer?.text });
        await interaction.update({ embeds: [updatedEmbed], components: [] });
      } else if (action === 'help') {
        await interaction.reply('Please include a screenshot of your common statistics (with hours)');
      }
    }

    if (['join_queue', 'leave_queue', 'clear_queue'].includes(customId)) {
      await interaction.deferUpdate(); // Acknowledge the interaction immediately
      db.get(`SELECT channel_id FROM queues WHERE channel_id = ? AND guild_id = ?`, [channelId, guildId], async (err, row) => {
        if (err || !row) return interaction.editReply('This is not a queue channel!');

        const msgId = await new Promise(resolve => {
          db.get(`SELECT value FROM settings WHERE key = ? AND guild_id = ?`, [`queue_message_${channelId}`, guildId], (err, row) => resolve(row?.value));
        });
        const channel = interaction.guild.channels.cache.get(channelId);
        const queueMsg = await channel.messages.fetch(msgId).catch(() => null);
        if (!queueMsg) return interaction.editReply('Queue message not found!');

        let embed = queueMsg.embeds[0];
        let players = embed.description.match(/\*\*Players:\*\*\n([\s\S]*?)\n\n\*\*Count:/)[1].split('\n').filter(p => p && p !== 'None');
        let count = players.length;
        const playerDisplayName = interaction.member.nickname || interaction.user.username;

        if (customId === 'join_queue') {
          if (players.includes(`<@${user.id}>`)) return; // Silently exit
          if (count >= 10) return interaction.editReply('Queue is full!');
          players.push(`<@${user.id}>`);
          count++;
          embed = EmbedBuilder.from(embed)
            .setDescription(`**Players:**\n${players.join('\n')}\n\n**Count:** ${count}/10`)
            .setFooter({ text: `@${playerDisplayName} joined the queue` });
          await queueMsg.edit({ embeds: [embed] });
          if (count === 10) await createMatch(db, channel, players, guildId);
        }

        if (customId === 'leave_queue') {
          const index = players.indexOf(`<@${user.id}>`);
          if (index === -1) return; // Silently exit
          players.splice(index, 1);
          count--;
          embed = EmbedBuilder.from(embed)
            .setDescription(`**Players:**\n${players.length ? players.join('\n') : 'None'}\n\n**Count:** ${count}/10`)
            .setFooter({ text: `@${playerDisplayName} left the queue` });
          await queueMsg.edit({ embeds: [embed] });
        }

        if (customId === 'clear_queue') {
          if (!isMod) return interaction.editReply('Only moderators can clear the queue!');
          embed = EmbedBuilder.from(embed)
            .setDescription(`**Players:**\nNone\n\n**Count:** 0/10`)
            .setFooter({ text: `@${playerDisplayName} cleared the queue` });
          await queueMsg.edit({ embeds: [embed] });
        }
      });
    }

    if (customId === 'next_match' || customId === 'maps' || customId === 'teams') {
      if (!isMod) return interaction.reply({ content: 'Only moderators can use this!', ephemeral: true });

      const matchEmbed = interaction.message.embeds[0];
      if (!matchEmbed || !matchEmbed.title || !matchEmbed.title.match(/Match #\d+/)) {
        return interaction.reply({ content: 'Invalid match embed!', ephemeral: true });
      }

      try {
        if (customId === 'next_match') {
          const matchNumberMatch = matchEmbed.title.match(/#(\d+)/);
          if (!matchNumberMatch) throw new Error('Could not extract match number from title');
          const matchNumber = matchNumberMatch[1];

          const ctMatch = matchEmbed.description.match(/\*\*CT Team 1:\*\*\n([\s\S]*?)\n\n\*\*TR Team 2:/);
          const trMatch = matchEmbed.description.match(/\*\*TR Team 2:\*\*\n([\s\S]*?)\n\n\*\*Map:/);
          const mapMatch = matchEmbed.description.match(/\*\*Map:\*\* (.*)/);
          if (!ctMatch || !trMatch || !mapMatch) throw new Error('Invalid embed description format for teams or map');

          const ctTeam = ctMatch[1].split('\n').filter(line => line.trim());
          const trTeam = trMatch[1].split('\n').filter(line => line.trim());
          const map = mapMatch[1];

          // Log match to results channel
          await new Promise((resolve, reject) => {
            db.run(`INSERT INTO matches (match_number, ct_team, tr_team, map, guild_id) VALUES (?, ?, ?, ?, ?)`,
              [matchNumber, ctTeam.join(','), trTeam.join(','), map, guildId], err => {
                if (err) {
                  console.error(`Error inserting match #${matchNumber}:`, err);
                  reject(err);
                } else {
                  console.log(`Match #${matchNumber} saved to database`);
                  resolve();
                }
              });
          });

          const resultsChannelId = await new Promise(resolve => {
            db.get(`SELECT value FROM settings WHERE key = 'results_channel' AND guild_id = ?`, [guildId], (err, row) => resolve(row?.value));
          });
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

          const queueTitle = await new Promise(resolve => {
            db.get(`SELECT title FROM queues WHERE channel_id = ? AND guild_id = ?`, [channelId, guildId], (err, row) => resolve(row?.title || 'Matchmaking Queue'));
          });
          const newQueueEmbed = new EmbedBuilder()
            .setTitle(queueTitle)
            .setDescription('**Players:**\nNone\n\n**Count:** 0/10')
            .setColor('#0099ff')
            .setFooter({ text: 'New queue started' })
            .setTimestamp();
          const queueRow = new ActionRowBuilder()
            .addComponents(
              new ButtonBuilder().setCustomId('join_queue').setLabel('Join').setStyle(ButtonStyle.Primary),
              new ButtonBuilder().setCustomId('leave_queue').setLabel('Leave').setStyle(ButtonStyle.Danger),
              new ButtonBuilder().setCustomId('clear_queue').setLabel('Clear').setStyle(ButtonStyle.Secondary)
            );
          const newQueueMsg = await interaction.channel.send({ embeds: [newQueueEmbed], components: [queueRow] });
          db.run(`INSERT OR REPLACE INTO settings (key, value, guild_id) VALUES (?, ?, ?)`, [`queue_message_${channelId}`, newQueueMsg.id, guildId]);

          await interaction.deferUpdate();
        }

        if (customId === 'maps') {
          const newMap = await getRandomMap(db, guildId);
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
        await interaction.reply({ content: 'An error occurred while processing this action!', ephemeral: true });
      }
    }
  }
});

client.login(config.token);