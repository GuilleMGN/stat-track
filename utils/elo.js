async function updatePlayerElo(db, userId, guildId, eloChange) {
  return new Promise((resolve, reject) => {
    db.run(
      `UPDATE players SET elo = elo + ? WHERE user_id = ? AND guild_id = ?`,
      [eloChange, userId, guildId],
      (err) => {
        if (err) reject(err);
        else resolve();
      }
    );
  });
}

module.exports = { updatePlayerElo };