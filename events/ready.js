module.exports = {
  name: 'ready',
  once: true,
  execute(client) {
    console.log(`Bot is online as ${client.user.tag}`);
  },
};