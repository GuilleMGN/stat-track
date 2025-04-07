const { EmbedBuilder } = require('discord.js');

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

module.exports = { assignRankedRole, getNextMatchNumber, shuffleAndSplit };