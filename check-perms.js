/* eslint-disable */
const { Client, GatewayIntentBits } = require('discord.js');
const fs = require('fs');
const dotenv = require('dotenv');

// Load config.env
const configContent = fs.readFileSync('/home/chihmin/.config/pi-discord-gateway/config.env', 'utf8');
const config = dotenv.parse(configContent);

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
  ]
});

client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag} (${client.user.id})`);
  
  for (const guild of client.guilds.cache.values()) {
    console.log(`\nGuild: ${guild.name} (${guild.id})`);
    
    // Get bot member
    const botMember = await guild.members.fetch(client.user.id).catch(() => null);
    if (!botMember) {
      console.log(`  Cannot fetch bot member!`);
      continue;
    }
    
    console.log(`  Bot Roles: ${botMember.roles.cache.map(r => `${r.name} (${r.id})`).join(', ')}`);
    console.log(`  Bot Guild Permissions: ${botMember.permissions.toArray().join(', ')}`);
    
    // Check channels
    const channels = await guild.channels.fetch();
    for (const channel of channels.values()) {
      if (!channel.isTextBased()) continue;
      
      const perms = channel.permissionsFor(botMember);
      console.log(`  Channel #${channel.name} (${channel.id}):`);
      console.log(`    Bot can View: ${perms ? perms.has('ViewChannel') : 'N/A'}`);
      console.log(`    Bot can Send: ${perms ? perms.has('SendMessages') : 'N/A'}`);
      console.log(`    Bot can Read History: ${perms ? perms.has('ReadMessageHistory') : 'N/A'}`);
      
      console.log(`    Permission Overrides:`);
      for (const override of channel.permissionOverwrites.cache.values()) {
        const type = override.type === 0 ? 'Role' : 'Member';
        const target = type === 'Role' ? guild.roles.cache.get(override.id)?.name : (await guild.members.fetch(override.id).catch(() => null))?.user.username;
        console.log(`      ${type} ${target || override.id}: allow: ${override.allow.toArray().join(', ')}, deny: ${override.deny.toArray().join(', ')}`);
      }
    }
  }
  
  client.destroy();
  process.exit(0);
});

client.login(config.DISCORD_BOT_TOKEN).catch(err => {
  console.error("Login failed:", err);
  process.exit(1);
});
