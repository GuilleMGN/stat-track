const { Client, EmbedBuilder, SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const sqlite3 = require('sqlite3').verbose();
const config = require('./config.json');

// Define client globally
const client = new Client({ intents: ['Guilds', 'GuildMessages', 'MessageContent', 'GuildMembers'] });

// Cache for database instances
const dbCache = new Map();

const getDb = (guildId) => {
  return new Promise((resolve, reject) => {
    if (dbCache.has(guildId)) {
      resolve(dbCache.get(guildId));
      return;
    }

    const db = new sqlite3.Database(`./maps_${guildId}.db`, (err) => {
      if (err) {
        console.error(`Database error for guild ${guildId}:`, err);
        reject(err);
      } else {
        console.log(`Connected to SQLite database for guild ${guildId}.`);
      }
    });

    db.serialize(() => {
      // Create tables
      db.run(`CREATE TABLE IF NOT EXISTS maps (map_name TEXT UNIQUE, guild_id TEXT, PRIMARY KEY (map_name, guild_id))`);
      db.run(`CREATE TABLE IF NOT EXISTS players (user_id TEXT, name TEXT UNIQUE, elo INTEGER DEFAULT 0, wins INTEGER DEFAULT 0, losses INTEGER DEFAULT 0, mvps INTEGER DEFAULT 0, guild_id TEXT, PRIMARY KEY (user_id, guild_id))`);
      db.run(`CREATE TABLE IF NOT EXISTS settings (key TEXT, value TEXT, guild_id TEXT, PRIMARY KEY (key, guild_id))`);
      db.run(`CREATE TABLE IF NOT EXISTS ranks (role_id TEXT, start_elo INTEGER, win_elo INTEGER, loss_elo INTEGER, mvp_elo INTEGER, guild_id TEXT, PRIMARY KEY (role_id, guild_id))`);
      db.run(`CREATE TABLE IF NOT EXISTS matches (match_number INTEGER, ct_team TEXT, tr_team TEXT, map TEXT, guild_id TEXT, scored INTEGER DEFAULT 0, winner_team INTEGER, mvp1 TEXT, mvp2 TEXT, bonus INTEGER, PRIMARY KEY (match_number, guild_id))`);
      db.run(`CREATE TABLE IF NOT EXISTS queues (channel_id TEXT, guild_id TEXT, title TEXT, voice_channel_id TEXT, role_id TEXT, PRIMARY KEY (channel_id, guild_id))`);

      // Check and update queues table schema
      db.all(`PRAGMA table_info(queues)`, (err, rows) => {
        if (err) {
          console.error('Error checking queues schema:', err);
          reject(err);
          return;
        }
        const columns = rows || [];
        const hasTitle = columns.some(row => row.name === 'title');
        const hasVoiceChannelId = columns.some(row => row.name === 'voice_channel_id');
        const hasRoleId = columns.some(row => row.name === 'role_id');

        const migrations = [];
        if (!hasTitle) {
          migrations.push(new Promise((res, rej) => {
            db.run(`ALTER TABLE queues ADD COLUMN title TEXT`, err => {
              if (err) {
                console.error('Error adding title column to queues:', err);
                rej(err);
              } else {
                console.log('Added title column to queues table');
                res();
              }
            });
          }));
        }
        if (!hasVoiceChannelId) {
          migrations.push(new Promise((res, rej) => {
            db.run(`ALTER TABLE queues ADD COLUMN voice_channel_id TEXT`, err => {
              if (err) {
                console.error('Error adding voice_channel_id column to queues:', err);
                rej(err);
              } else {
                console.log('Added voice_channel_id column to queues table');
                res();
              }
            });
          }));
        }
        if (!hasRoleId) {
          migrations.push(new Promise((res, rej) => {
            db.run(`ALTER TABLE queues ADD COLUMN role_id TEXT`, err => {
              if (err) {
                console.error('Error adding role_id column to queues:', err);
                rej(err);
              } else {
                console.log('Added role_id column to queues table');
                res();
              }
            });
          }));
        }

        // Wait for all migrations to complete
        Promise.all(migrations)
          .then(() => {
            // Check and update matches table schema
            db.all(`PRAGMA table_info(matches)`, (err, rows) => {
              if (err) {
                console.error('Error checking matches schema:', err);
                reject(err);
                return;
              }
              const columns = rows || [];
              const hasScored = columns.some(row => row.name === 'scored');
              const hasWinnerTeam = columns.some(row => row.name === 'winner_team');
              const hasMvp1 = columns.some(row => row.name === 'mvp1');
              const hasMvp2 = columns.some(row => row.name === 'mvp2');
              const hasBonus = columns.some(row => row.name === 'bonus');

              const matchMigrations = [];
              if (!hasScored) {
                matchMigrations.push(new Promise((res, rej) => {
                  db.run(`ALTER TABLE matches ADD COLUMN scored INTEGER DEFAULT 0`, err => {
                    if (err) rej(err);
                    else res();
                  });
                }));
              }
              if (!hasWinnerTeam) {
                matchMigrations.push(new Promise((res, rej) => {
                  db.run(`ALTER TABLE matches ADD COLUMN winner_team INTEGER`, err => {
                    if (err) rej(err);
                    else res();
                  });
                }));
              }
              if (!hasMvp1) {
                matchMigrations.push(new Promise((res, rej) => {
                  db.run(`ALTER TABLE matches ADD COLUMN mvp1 TEXT`, err => {
                    if (err) rej(err);
                    else res();
                  });
                }));
              }
              if (!hasMvp2) {
                matchMigrations.push(new Promise((res, rej) => {
                  db.run(`ALTER TABLE matches ADD COLUMN mvp2 TEXT`, err => {
                    if (err) rej(err);
                    else res();
                  });
                }));
              }
              if (!hasBonus) {
                matchMigrations.push(new Promise((res, rej) => {
                  db.run(`ALTER TABLE matches ADD COLUMN bonus INTEGER`, err => {
                    if (err) rej(err);
                    else res();
                  });
                }));
              }

              Promise.all(matchMigrations)
                .then(() => {
                  dbCache.set(guildId, db);
                  resolve(db);
                })
                .catch(reject);
            });
          })
          .catch(reject);
      });
    });
  });
};

const assignRankedRole = async (db, guild, userId, elo) => {
  const ranks = await new Promise(resolve => {
    db.all(`SELECT role_id, start_elo FROM ranks WHERE guild_id = ? ORDER BY start_elo DESC`, [guild.id], (err, rows) => resolve(rows || []));
  });
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

const getNextMatchNumber = (db, guildId) => new Promise(resolve => {
  db.get(`SELECT MAX(match_number) as max FROM matches WHERE guild_id = ?`, [guildId], (err, row) => {
    if (err) {
      console.error(`Error getting next match number for guild ${guildId}:`, err);
      return resolve(1); // Fallback to 1 if query fails
    }
    const nextNumber = (row?.max || 0) + 1;
    console.log(`Next match number for guild ${guildId}: ${nextNumber}`);
    resolve(nextNumber);
  });
});

const shuffleAndSplit = (players) => {
  const shuffled = [...players].sort(() => Math.random() - 0.5);
  return [shuffled.slice(0, 5), shuffled.slice(5)];
};

const getRandomMap = async (db, guildId) => {
  const maps = await new Promise(resolve => {
    db.all(`SELECT map_name FROM maps WHERE guild_id = ?`, [guildId], (err, rows) => resolve(rows?.map(row => row.map_name) || []));
  });
  return maps.length ? maps[Math.floor(Math.random() * maps.length)] : 'Default Map';
};

const updatePlayerEloAndRank = async (db, guild, userId, eloChange, isMvp, bonus, channelId) => {
  return new Promise((resolve) => {
    db.get(`SELECT elo, name FROM players WHERE user_id = ? AND guild_id = ?`, [userId, guild.id], async (err, row) => {
      if (err || !row) {
        console.error(`Error fetching player ${userId} in guild ${guild.id}:`, err);
        return resolve({ oldElo: 0, newElo: 0, name: 'Unknown' });
      }
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

      // Fetch the member if not in cache
      let member;
      try {
        member = guild.members.cache.get(userId) || (await guild.members.fetch(userId));
      } catch (error) {
        console.error(`Failed to fetch member ${userId} in guild ${guild.id}:`, error);
        return resolve({ oldElo, newElo, name: row.name }); // Skip role updates if member fetch fails
      }

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
  const matchNumber = await new Promise(resolve => {
    db.get(`SELECT MAX(match_number) as max FROM matches WHERE guild_id = ?`, [guildId], (err, row) => {
      if (err) {
        console.error('Error getting max match number:', err);
        resolve(1);
      } else {
        resolve((row?.max || 0) + 1);
      }
    });
  });

  const [ctTeam, trTeam] = shuffleAndSplit(players);
  const map = await getRandomMap(db, guildId);
  const bonus = await new Promise(resolve => {
    db.get(`SELECT value FROM settings WHERE key = ? AND guild_id = ?`, [`queue_bonus_${channel.id}`, guildId], (err, row) => resolve(parseInt(row?.value) || 0));
  });

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
].map(command => command.toJSON());

client.once('ready', async () => {
  console.log('Bot is online!');
  try {
    await client.application.commands.set(commands);
    console.log('Slash commands registered!');

    // Process each guild sequentially
    for (const guild of client.guilds.cache.values()) {
      try {
        // Wait for the database to be fully set up
        const db = await getDb(guild.id);

        // Fetch all queues for this guild
        const queues = await new Promise(resolve => {
          db.all(`SELECT channel_id, role_id, title FROM queues WHERE guild_id = ?`, [guild.id], (err, rows) => {
            if (err) {
              console.error(`Error fetching queues for guild ${guild.id}:`, err);
              resolve([]);
            } else {
              resolve(rows || []);
            }
          });
        });

        for (const queue of queues) {
          const { channel_id, role_id, title } = queue;
          const channel = guild.channels.cache.get(channel_id);
          if (!channel) continue;

          const msgId = await new Promise(resolve => {
            db.get(`SELECT value FROM settings WHERE key = ? AND guild_id = ?`, [`queue_message_${channel_id}`, guild.id], (err, row) => resolve(row?.value));
          });
          if (!msgId) continue;

          const queueMsg = await channel.messages.fetch(msgId).catch(() => null);
          if (!queueMsg) continue;

          // Get all members with the role
          const membersWithRole = guild.members.cache.filter(member => member.roles.cache.has(role_id));
          const players = [];
          for (const member of membersWithRole.values()) {
            const isRegistered = await new Promise(resolve => {
              db.get(`SELECT 1 FROM players WHERE user_id = ? AND guild_id = ?`, [member.id, guild.id], (err, row) => {
                if (err) {
                  console.error(`Error checking player registration for ${member.id}:`, err);
                  resolve(false);
                } else {
                  resolve(!!row);
                }
              });
            });

            if (isRegistered) {
              players.push(`<@${member.id}>`);
            }
          }

          const embed = EmbedBuilder.from(queueMsg.embeds[0])
            .setDescription(`**Players:**\n${players.length ? players.join('\n') : 'None'}\n\n**Count:** ${players.length}/10`)
            .setFooter({ text: 'Queue initialized on bot startup' });
          await queueMsg.edit({ embeds: [embed] });

          if (players.length === 10) {
            await createMatch(db, channel, players, guild.id);
          }
        }
      } catch (error) {
        console.error(`Error initializing queues for guild ${guild.id}:`, error);
      }
    }
  } catch (error) {
    console.error('Error registering commands or initializing queues:', error);
  }
});

client.on('interactionCreate', async interaction => {
  if (!interaction.guild) return;
  const db = await getDb(interaction.guildId);
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
      if (!isMod) return interaction.reply('Only moderators can use this command!'); // Fixed typo here
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
      if (!isMod) return interaction.reply({ content: 'Only moderators can use this command!', flags: [4096] });
      const matchId = options.getInteger('match_id');
      const winnerTeam = options.getInteger('winner_team');
      const mvp1 = options.getUser('mvp1');
      const mvp2 = options.getUser('mvp2');
      if (winnerTeam !== 1 && winnerTeam !== 2) return interaction.reply('Winner team must be 1 or 2!');

      console.log(`Scoring match: matchId=${matchId}, guildId=${interaction.guildId}`);
      db.get(`SELECT ct_team, tr_team, scored, guild_id FROM matches WHERE match_number = ? AND guild_id = ?`, [matchId, interaction.guildId], async (err, row) => {
        if (err) {
          console.error('Error querying match:', err);
          return interaction.reply(`Error checking Match #${matchId}!`);
        }
        console.log(`Query result:`, row);
        if (!row) return interaction.reply(`Match #${matchId} not found!`);
        if (row.scored) return interaction.reply(`Match #${matchId} has already been scored!`);

        const ctTeam = row.ct_team.split(',').map(id => id.trim().replace(/<@|>/g, '')); // Strip <@ and >
        const trTeam = row.tr_team.split(',').map(id => id.trim().replace(/<@|>/g, '')); // Strip <@ and >
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

        // Save match result details
        db.run(`UPDATE matches SET scored = 1, winner_team = ?, mvp1 = ?, mvp2 = ?, bonus = ? WHERE match_number = ? AND guild_id = ?`,
          [winnerTeam, mvp1?.id || null, mvp2?.id || null, bonus, matchId, interaction.guildId], err => {
            if (err) console.error(`Error updating match #${matchId} with result details:`, err);
          });

        const embed = new EmbedBuilder()
          .setTitle(`Match #${matchId} Results`)
          .setDescription(eloChanges.join('\n'))
          .setColor('#00ff00')
          .setFooter({ text: `Match #${matchId} has been scored` });
        interaction.reply({ embeds: [embed] });
      });
    }

    if (commandName === 'sub') {
      if (!isMod) return interaction.reply({ content: 'Only moderators can use this command!', flags: [4096] });
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
      if (!isMod) return interaction.reply({ content: 'Only moderators can use this command!', flags: [4096] });
      const matchId = options.getInteger('match_id');
      db.get(`SELECT ct_team, tr_team, scored, guild_id, winner_team, mvp1, mvp2, bonus FROM matches WHERE match_number = ? AND guild_id = ?`, [matchId, interaction.guildId], async (err, row) => {
        if (err) {
          console.error('Error querying match for undo:', err);
          return interaction.reply(`Error checking Match #${matchId}!`);
        }
        if (!row) return interaction.reply(`Match #${matchId} not found!`);
        if (!row.scored) return interaction.reply(`Match #${matchId} has not been scored!`);

        const ctTeam = row.ct_team.split(',').map(id => id.trim().replace(/<@|>/g, '')); // Strip <@ and >
        const trTeam = row.tr_team.split(',').map(id => id.trim().replace(/<@|>/g, '')); // Strip <@ and >
        const winningTeam = row.winner_team === 1 ? ctTeam : trTeam;
        const losingTeam = row.winner_team === 1 ? trTeam : ctTeam;
        const mvp1 = row.mvp1;
        const mvp2 = row.mvp2;
        const bonus = row.bonus || 0;

        const eloChanges = [];
        // Undo for winners
        for (const userId of winningTeam) {
          const playerData = await new Promise(resolve => {
            db.get(`SELECT elo, name FROM players WHERE user_id = ? AND guild_id = ?`, [userId, interaction.guildId], (err, row) => {
              if (err) {
                console.error(`Error fetching player ${userId}:`, err);
                resolve(null);
              } else {
                resolve(row);
              }
            });
          });
          if (!playerData) {
            eloChanges.push(`[N/A] -> [N/A] Unknown (${userId})`);
            continue;
          }
          const { elo: currentElo, name } = playerData;
          const rank = await new Promise(resolve => {
            db.get(`SELECT win_elo FROM ranks WHERE start_elo <= ? AND guild_id = ? ORDER BY start_elo DESC LIMIT 1`, [currentElo, interaction.guildId], (err, row) => resolve(row));
          });
          const winElo = rank?.win_elo || 0;
          let eloChange = -winElo; // Reverse the win Elo
          const isMvp = (userId === mvp1 || userId === mvp2);
          if (isMvp) {
            const mvpElo = await new Promise(resolve => {
              db.get(`SELECT mvp_elo FROM ranks WHERE start_elo <= ? AND guild_id = ? ORDER BY start_elo DESC LIMIT 1`, [currentElo, interaction.guildId], (err, row) => resolve(row?.mvp_elo || 0));
            });
            eloChange -= mvpElo; // Reverse MVP bonus
          }
          eloChange -= bonus; // Reverse queue bonus
          const newElo = Math.max(0, currentElo + eloChange);
          db.run(`UPDATE players SET elo = ? WHERE user_id = ? AND guild_id = ?`, [newElo, userId, interaction.guildId]);
          await assignRankedRole(db, interaction.guild, userId, newElo);
          eloChanges.push(`[${currentElo}] -> [${newElo}] ${name}`);
        }
        // Undo for losers
        for (const userId of losingTeam) {
          const playerData = await new Promise(resolve => {
            db.get(`SELECT elo, name FROM players WHERE user_id = ? AND guild_id = ?`, [userId, interaction.guildId], (err, row) => {
              if (err) {
                console.error(`Error fetching player ${userId}:`, err);
                resolve(null);
              } else {
                resolve(row);
              }
            });
          });
          if (!playerData) {
            eloChanges.push(`[N/A] -> [N/A] Unknown (${userId})`);
            continue;
          }
          const { elo: currentElo, name } = playerData;
          const rank = await new Promise(resolve => {
            db.get(`SELECT loss_elo FROM ranks WHERE start_elo <= ? AND guild_id = ? ORDER BY start_elo DESC LIMIT 1`, [currentElo, interaction.guildId], (err, row) => resolve(row));
          });
          const lossElo = rank?.loss_elo || 0;
          // Simulate the original /score logic to determine if Elo actually changed
          const simulatedOldElo = currentElo; // Current Elo after /score
          const simulatedScoreChange = -(lossElo);
          const simulatedNewEloDuringScore = Math.max(0, simulatedOldElo + simulatedScoreChange); // What /score set it to
          let eloChange = 0;
          if (simulatedNewEloDuringScore < simulatedOldElo) {
            // If /score actually reduced the Elo, reverse it
            eloChange = lossElo; // Add back the lossElo (e.g., +22)
          }
          // Note: No bonus or MVP for losers in this case, but include if applicable
          const isMvp = (userId === mvp1 || userId === mvp2);
          if (isMvp) {
            const mvpElo = await new Promise(resolve => {
              db.get(`SELECT mvp_elo FROM ranks WHERE start_elo <= ? AND guild_id = ? ORDER BY start_elo DESC LIMIT 1`, [currentElo, interaction.guildId], (err, row) => resolve(row?.mvp_elo || 0));
            });
            eloChange -= mvpElo; // Reverse MVP bonus
          }
          const newElo = Math.max(0, currentElo + eloChange);
          db.run(`UPDATE players SET elo = ? WHERE user_id = ? AND guild_id = ?`, [newElo, userId, interaction.guildId]);
          await assignRankedRole(db, interaction.guild, userId, newElo);
          eloChanges.push(`[${currentElo}] -> [${newElo}] ${name}`);
        }

        // Mark match as unscored and clear result details
        db.run(`UPDATE matches SET scored = 0, winner_team = NULL, mvp1 = NULL, mvp2 = NULL, bonus = NULL WHERE match_number = ? AND guild_id = ?`, [matchId, interaction.guildId]);

        const embed = new EmbedBuilder()
          .setTitle(`Match #${matchId} Undo Results`)
          .setDescription(eloChanges.length > 0 ? eloChanges.join('\n') : 'No Elo changes applied (players not found).')
          .setColor('#ff0000')
          .setFooter({ text: `Match #${matchId} has been unscored` });
        interaction.reply({ embeds: [embed] });
      });
    }

    if (commandName === 'set_updates_channel') {
      if (!isMod) return interaction.reply({ content: 'Only moderators can use this command!', flags: [4096] });
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
      const voiceChannel = options.getChannel('voice_channel_id');
      const role = options.getRole('role');
      const title = options.getString('title') || 'Matchmaking Queue';
      const bonus = options.getInteger('bonus') || 0;

      if (channel.type !== 0) return interaction.reply('The channel_id must be a text channel!');
      if (voiceChannel.type !== 2) return interaction.reply('The voice_channel_id must be a voice channel!');

      try {
        await new Promise((resolve, reject) => {
          db.run(
            `INSERT OR IGNORE INTO queues (channel_id, guild_id, title, voice_channel_id, role_id) VALUES (?, ?, ?, ?, ?)`,
            [channel.id, interaction.guildId, title, voiceChannel.id, role.id],
            err => {
              if (err) {
                console.error('Error inserting into queues:', err);
                reject(err);
              } else {
                resolve();
              }
            }
          );
        });

        const embed = new EmbedBuilder()
          .setTitle(title)
          .setDescription('**Players:**\nNone\n\n**Count:** 0/10')
          .setColor('#0099ff')
          .setFooter({ text: 'Queue initialized' })
          .setTimestamp();

        const msg = await channel.send({ embeds: [embed] });
        await new Promise(resolve => {
          db.run(
            `INSERT OR REPLACE INTO settings (key, value, guild_id) VALUES (?, ?, ?)`,
            [`queue_message_${channel.id}`, msg.id, interaction.guildId],
            err => {
              if (err) console.error('Error setting queue message ID:', err);
              resolve();
            }
          );
        });
        await new Promise(resolve => {
          db.run(
            `INSERT OR REPLACE INTO settings (key, value, guild_id) VALUES (?, ?, ?)`,
            [`queue_bonus_${channel.id}`, bonus, interaction.guildId],
            err => {
              if (err) console.error('Error setting queue bonus:', err);
              resolve();
            }
          );
        });
        interaction.reply(`Queue channel set to <#${channel.id}> with voice channel <#${voiceChannel.id}> and role <@&${role.id}>!`);
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
      db.all(`SELECT channel_id, voice_channel_id, role_id, title FROM queues WHERE guild_id = ?`, [interaction.guildId], async (err, rows) => {
        if (err) return interaction.reply('Error fetching queues!');

        const queueList = [];
        for (const row of rows) {
          const bonus = await new Promise(resolve => {
            db.get(`SELECT value FROM settings WHERE key = ? AND guild_id = ?`, [`queue_bonus_${row.channel_id}`, interaction.guildId], (err, row) => resolve(parseInt(row?.value) || 0));
          });
          queueList.push(
            `**Text Channel:** <#${row.channel_id}>\n` +
            `**Voice Channel:** <#${row.voice_channel_id}>\n` +
            `**Role:** <@&${row.role_id}>\n` +
            `**Title:** ${row.title}\n` +
            `**Bonus Elo:** ${bonus}`
          );
        }

        const embed = new EmbedBuilder()
          .setTitle('Queue Channels')
          .setDescription(queueList.length ? queueList.join('\n\n') : 'No queue channels set.')
          .setColor('#0099ff')
          .setTimestamp();
        interaction.reply({ embeds: [embed] });
      });
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

      await interaction.reply({ embeds: [embed], components: [row] });
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
    const db = await getDb(guildId);

    if (customId.startsWith('approve_') || customId.startsWith('decline_') || customId.startsWith('help_')) {
      const [action, userId] = customId.split('_');
      if (!isMod && (action === 'approve' || action === 'decline')) {
        return interaction.reply({ content: 'Only moderators can approve/decline registrations!', flags: [4096] });
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

    if (customId === 'next_match' || customId === 'maps' || customId === 'teams') {
      if (!isMod) return interaction.reply({ content: 'Only moderators can use this!', flags: [4096] });

      const matchEmbed = interaction.message.embeds[0];
      if (!matchEmbed || !matchEmbed.title || !matchEmbed.title.match(/Match #\d+/)) {
        return interaction.reply({ content: 'Invalid match embed!', flags: [4096] });
      }

      try {
        if (customId === 'next_match') {
          try {
            const matchNumberMatch = matchEmbed.title.match(/#(\d+)/);
            if (!matchNumberMatch) throw new Error('Could not extract match number from title');
            const matchNumber = matchNumberMatch[1];

            const ctMatch = matchEmbed.description.match(/\*\*CT Team 1:\*\*\n([\s\S]*?)\n\n\*\*TR Team 2:/);
            const trMatch = matchEmbed.description.match(/\*\*TR Team 2:\*\*\n([\s\S]*?)\n\n\*\*Map:/);
            const mapMatch = matchEmbed.description.match(/\*\*Map:\*\* (.*)/);
            if (!ctMatch || !trMatch || !mapMatch) throw new Error('Invalid embed description format for teams or map');

            const ctTeam = ctMatch[1].split('\n').filter(line => line.trim()).map(id => id.replace(/<@|>/g, '')); // Clean IDs
            const trTeam = trMatch[1].split('\n').filter(line => line.trim()).map(id => id.replace(/<@|>/g, '')); // Clean IDs
            const map = mapMatch[1];

            // Log match to results channel
            await new Promise((resolve, reject) => {
              db.run(
                `INSERT INTO matches (match_number, ct_team, tr_team, map, guild_id) VALUES (?, ?, ?, ?, ?)`,
                [matchNumber, ctTeam.join(','), trTeam.join(','), map, guildId],
                err => {
                  if (err) {
                    console.error(`Error inserting match #${matchNumber}:`, err);
                    reject(err);
                  } else {
                    console.log(`Match #${matchNumber} saved to database`);
                    resolve();
                  }
                }
              );
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

            // Fetch the voice channel ID for this queue
            const voiceChannelId = await new Promise(resolve => {
              db.get(`SELECT voice_channel_id FROM queues WHERE channel_id = ? AND guild_id = ?`, [channelId, guildId], (err, row) => {
                if (err) {
                  console.error(`Error fetching voice_channel_id for channel ${channelId}:`, err);
                  resolve(null);
                } else {
                  resolve(row?.voice_channel_id);
                }
              });
            });

            if (voiceChannelId) {
              const voiceChannel = interaction.guild.channels.cache.get(voiceChannelId);
              if (voiceChannel && voiceChannel.type === 2) {
                const members = voiceChannel.members;
                for (const member of members.values()) {
                  try {
                    await member.voice.disconnect();
                    console.log(`Kicked ${member.user.tag} from voice channel ${voiceChannelId}`);
                  } catch (error) {
                    console.error(`Failed to kick ${member.user.tag} from voice channel ${voiceChannelId}:`, error);
                  }
                }
              }
            }

            // Create a new queue embed
            const queueTitle = await new Promise(resolve => {
              db.get(`SELECT title FROM queues WHERE channel_id = ? AND guild_id = ?`, [channelId, guildId], (err, row) => resolve(row?.title || 'Matchmaking Queue'));
            });
            const newQueueEmbed = new EmbedBuilder()
              .setTitle(queueTitle)
              .setDescription('**Players:**\nNone\n\n**Count:** 0/10')
              .setColor('#0099ff')
              .setFooter({ text: 'New queue started' })
              .setTimestamp();
            const newQueueMsg = await interaction.channel.send({ embeds: [newQueueEmbed] });
            db.run(`INSERT OR REPLACE INTO settings (key, value, guild_id) VALUES (?, ?, ?)`, [`queue_message_${channelId}`, newQueueMsg.id, guildId]);

            await interaction.deferUpdate();
          } catch (error) {
            console.error(`Button handler error (next_match):`, error);
            await interaction.reply({ content: 'An error occurred while processing this action!', flags: [4096] });
          }
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
        await interaction.reply({ content: 'An error occurred while processing this action!', flags: [4096] });
      }
    }

    if (customId === 'reset_season_yes' || customId === 'reset_season_no') {
      if (!isMod) return interaction.reply({ content: 'Only moderators can confirm this action!', flags: [4096] });

      // Defer the interaction to prevent timeout
      await interaction.deferUpdate();

      const embed = interaction.message.embeds[0];

      // Disable the buttons after an action is taken
      const disabledRow = new ActionRowBuilder()
        .addComponents(
          new ButtonBuilder().setCustomId('reset_season_yes').setLabel('Yes').setStyle(ButtonStyle.Danger).setDisabled(true),
          new ButtonBuilder().setCustomId('reset_season_no').setLabel('No').setStyle(ButtonStyle.Secondary).setDisabled(true)
        );

      if (customId === 'reset_season_yes') {
        try {
          // Reset all matches
          await new Promise((resolve, reject) => {
            db.run(`DELETE FROM matches WHERE guild_id = ?`, [guildId], err => {
              if (err) {
                console.error(`Error deleting matches for guild ${guildId}:`, err);
                reject(err);
              } else {
                console.log(`Matches deleted for guild ${guildId}`);
                resolve();
              }
            });
          });

          // Reset all player stats (elo, wins, losses, mvps) while keeping players registered
          await new Promise((resolve, reject) => {
            db.run(`UPDATE players SET elo = 0, wins = 0, losses = 0, mvps = 0 WHERE guild_id = ?`, [guildId], err => {
              if (err) {
                console.error(`Error resetting player stats for guild ${guildId}:`, err);
                reject(err);
              } else {
                console.log(`Player stats reset for guild ${guildId}`);
                resolve();
              }
            });
          });

          // Fetch rank roles to remove existing ones
          const rankRoles = await new Promise(resolve => {
            db.all(`SELECT role_id FROM ranks WHERE guild_id = ?`, [guildId], (err, rows) => {
              if (err) {
                console.error(`Error fetching rank roles for guild ${guildId}:`, err);
                resolve([]);
              } else {
                resolve(rows?.map(row => row.role_id) || []);
              }
            });
          });

          // Fetch all players
          const players = await new Promise(resolve => {
            db.all(`SELECT user_id FROM players WHERE guild_id = ?`, [guildId], (err, rows) => {
              if (err) {
                console.error(`Error fetching players for guild ${guildId}:`, err);
                resolve([]);
              } else {
                resolve(rows || []);
              }
            });
          });

          // Process each player: remove rank roles, update nickname, and reassign rank role
          for (const player of players) {
            try {
              const member = interaction.guild.members.cache.get(player.user_id) || (await interaction.guild.members.fetch(player.user_id));
              if (member) {
                // Remove existing rank roles
                await member.roles.remove(rankRoles).catch(err => console.error(`Failed to remove roles for user ${player.user_id}:`, err));

                // Update nickname to reflect new Elo (0)
                const playerData = await new Promise(resolve => {
                  db.get(`SELECT name FROM players WHERE user_id = ? AND guild_id = ?`, [player.user_id, guildId], (err, row) => {
                    if (err) {
                      console.error(`Error fetching player data for user ${player.user_id}:`, err);
                      resolve(null);
                    } else {
                      resolve(row);
                    }
                  });
                });

                if (playerData) {
                  try {
                    await member.setNickname(`0 | ${playerData.name}`);
                  } catch (error) {
                    if (error.code === 50013) { // DiscordAPIError: Missing Permissions
                      console.log(`Skipped nickname update for user ${player.user_id} due to missing permissions (likely server owner).`);
                    } else {
                      console.error(`Failed to update nickname for user ${player.user_id}:`, error);
                    }
                  }
                }

                // Reassign rank role based on new Elo (0)
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

client.on('guildMemberUpdate', async (oldMember, newMember) => {
  const guildId = newMember.guild.id;
  const db = await getDb(guildId);

  // Fetch all queues for this guild
  const queues = await new Promise(resolve => {
    db.all(`SELECT channel_id, role_id, title FROM queues WHERE guild_id = ?`, [guildId], (err, rows) => {
      if (err) {
        console.error(`Error fetching queues for guild ${guildId}:`, err);
        resolve([]);
      } else {
        resolve(rows || []);
      }
    });
  });

  for (const queue of queues) {
    const { channel_id, role_id, title } = queue;
    const channel = newMember.guild.channels.cache.get(channel_id);
    if (!channel) continue;

    const msgId = await new Promise(resolve => {
      db.get(`SELECT value FROM settings WHERE key = ? AND guild_id = ?`, [`queue_message_${channel_id}`, guildId], (err, row) => resolve(row?.value));
    });
    if (!msgId) continue;

    const queueMsg = await channel.messages.fetch(msgId).catch(() => null);
    if (!queueMsg) continue;

    let embed = queueMsg.embeds[0];
    let players = embed.description.match(/\*\*Players:\*\*\n([\s\S]*?)\n\n\*\*Count:/)[1].split('\n').filter(p => p && p !== 'None');
    let count = players.length;

    const hadRole = oldMember.roles.cache.has(role_id);
    const hasRole = newMember.roles.cache.has(role_id);

    if (!hadRole && hasRole) {
      // Member gained the role
      if (players.includes(`<@${newMember.id}>`)) continue; // Already in queue
      if (count >= 10) continue; // Queue is full

      // Check if the member is registered
      const isRegistered = await new Promise(resolve => {
        db.get(`SELECT 1 FROM players WHERE user_id = ? AND guild_id = ?`, [newMember.id, guildId], (err, row) => {
          if (err) {
            console.error(`Error checking player registration for ${newMember.id}:`, err);
            resolve(false);
          } else {
            resolve(!!row);
          }
        });
      });

      if (!isRegistered) continue; // Skip unregistered players

      players.push(`<@${newMember.id}>`);
      count++;
      embed = EmbedBuilder.from(embed)
        .setDescription(`**Players:**\n${players.join('\n')}\n\n**Count:** ${count}/10`)
        .setFooter({ text: `@${newMember.displayName} joined the queue` });
      await queueMsg.edit({ embeds: [embed] });

      if (count === 10) {
        await createMatch(db, channel, players, guildId);
      }
    } else if (hadRole && !hasRole) {
      // Member lost the role
      const index = players.indexOf(`<@${newMember.id}>`);
      if (index === -1) continue; // Not in queue

      players.splice(index, 1);
      count--;
      embed = EmbedBuilder.from(embed)
        .setDescription(`**Players:**\n${players.length ? players.join('\n') : 'None'}\n\n**Count:** ${count}/10`)
        .setFooter({ text: `@${newMember.displayName} left the queue` });
      await queueMsg.edit({ embeds: [embed] });
    }
  }
});

client.login(config.token);