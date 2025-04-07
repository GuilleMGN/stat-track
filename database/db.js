const sqlite3 = require('sqlite3').verbose();
const dbCache = new Map();

const getDb = (guildId) => {
  if (dbCache.has(guildId)) {
    return dbCache.get(guildId);
  }

  const db = new sqlite3.Database(`./maps_${guildId}.db`, (err) => {
    if (err) console.error(`Database error for guild ${guildId}:`, err);
    console.log(`Connected to SQLite database for guild ${guildId}.`);
  });

  // Agregar métodos asincrónicos (promisificados)
  db.allAsync = (sql, params = []) => {
    return new Promise((resolve, reject) => {
      db.all(sql, params, (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
      });
    });
  };

  db.getAsync = (sql, params = []) => {
    return new Promise((resolve, reject) => {
      db.get(sql, params, (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });
  };

  db.runAsync = (sql, params = []) => {
    return new Promise((resolve, reject) => {
      db.run(sql, params, function (err) {
        if (err) reject(err);
        else resolve(this);
      });
    });
  };

  dbCache.set(guildId, db);
  return db;
};

module.exports = { getDb };
