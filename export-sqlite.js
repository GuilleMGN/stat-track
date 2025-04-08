const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');

const guildId = '1357802600740946234'; 
const db = new sqlite3.Database(`./maps_1357802600740946234.db`);

const tables = ['maps', 'players', 'settings', 'ranks', 'matches', 'queues'];
const data = {};

async function exportTable(table) {
  return new Promise((resolve, reject) => {
    db.all(`SELECT * FROM ${table}`, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

(async () => {
  for (const table of tables) {
    data[table] = await exportTable(table);
  }
  fs.writeFileSync(`db_${guildId}.json`, JSON.stringify(data, null, 2));
  console.log('Data exported to JSON');
  db.close();
})();