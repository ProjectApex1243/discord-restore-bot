import http from 'node:http';
import {
  AuditLogEvent, ChannelType, Client, Events, GatewayIntentBits,
  PermissionFlagsBits, SlashCommandBuilder,
} from 'discord.js';

const command = new SlashCommandBuilder()
  .setName('restore')
  .setDescription('Recreate deleted roles and channels from the audit log')
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addIntegerOption(o => o.setName('hours').setDescription('How far back to look (default 24)').setMinValue(1).setMaxValue(1080))
  .addBooleanOption(o => o.setName('preview').setDescription('List what would be restored, change nothing'));

const CHANNEL_TYPES = new Set([
  ChannelType.GuildText, ChannelType.GuildVoice, ChannelType.GuildCategory,
  ChannelType.GuildAnnouncement, ChannelType.GuildStageVoice, ChannelType.GuildForum,
]);

// Audit log pages are newest-first, 100 max; returns entries since `since`, oldest first.
async function fetchAll(guild, type, since) {
  const out = [];
  let before;
  for (;;) {
    const { entries } = await guild.fetchAuditLogs({ type, limit: 100, before });
    if (!entries.size) break;
    for (const e of entries.values()) if (e.createdTimestamp >= since) out.push(e);
    const last = entries.last();
    if (entries.size < 100 || last.createdTimestamp < since) break;
    before = last.id;
  }
  return out.reverse();
}

const oldValues = e => Object.fromEntries(e.changes.map(c => [c.key, c.old]));

async function restore(guild, since, preview) {
  const log = [];
  await guild.roles.fetch();
  await guild.channels.fetch();
  const roleMap = new Map(); // deleted id -> live id
  const chanMap = new Map();

  for (const e of await fetchAll(guild, AuditLogEvent.RoleDelete, since)) {
    const o = oldValues(e);
    if (!o.name) continue;
    const existing = guild.roles.cache.find(r => r.name === o.name);
    if (existing) { roleMap.set(e.targetId, existing.id); continue; }
    if (preview) { log.push(`would create role **${o.name}**`); continue; }
    try {
      const r = await guild.roles.create({
        name: o.name, color: o.color ?? 0, hoist: !!o.hoist, mentionable: !!o.mentionable,
        permissions: BigInt(o.permissions ?? 0),
      });
      roleMap.set(e.targetId, r.id);
      log.push(`role **${o.name}** ✅`);
    } catch (err) { log.push(`role **${o.name}** ❌ ${err.message}`); }
  }

  const chans = (await fetchAll(guild, AuditLogEvent.ChannelDelete, since))
    .map(e => ({ id: e.targetId, o: oldValues(e) }))
    .filter(c => c.o.name && CHANNEL_TYPES.has(c.o.type));
  const isCat = c => c.o.type === ChannelType.GuildCategory;
  for (const { id, o } of [...chans.filter(isCat), ...chans.filter(c => !isCat(c))]) {
    const existing = guild.channels.cache.find(c => c.name === o.name && c.type === o.type);
    if (existing) { chanMap.set(id, existing.id); continue; }
    if (preview) { log.push(`would create #${o.name}`); continue; }
    const parent = chanMap.get(o.parent_id) ?? (guild.channels.cache.has(o.parent_id) ? o.parent_id : undefined);
    const permissionOverwrites = (o.permission_overwrites ?? [])
      .map(p => ({ id: Number(p.type) === 0 ? roleMap.get(p.id) ?? p.id : p.id, type: Number(p.type), allow: BigInt(p.allow), deny: BigInt(p.deny) }))
      .filter(p => p.type !== 0 || guild.roles.cache.has(p.id));
    const base = { name: o.name, type: o.type, parent };
    try {
      let c;
      try {
        c = await guild.channels.create({
          ...base, topic: o.topic, nsfw: o.nsfw, rateLimitPerUser: o.rate_limit_per_user,
          bitrate: o.bitrate, userLimit: o.user_limit, permissionOverwrites,
        });
      } catch { c = await guild.channels.create(base); } // bad bitrate / dead member overwrite
      chanMap.set(id, c.id);
      log.push(`#${o.name} ✅`);
    } catch (err) { log.push(`#${o.name} ❌ ${err.message}`); }
  }
  return log.length ? log : ['nothing to restore in that window'];
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });
const register = g => g.commands.set([command.toJSON()]).catch(console.error);

client.once(Events.ClientReady, c => { console.log(`up as ${c.user.tag}`); c.guilds.cache.forEach(register); });
client.on(Events.GuildCreate, register);

client.on(Events.InteractionCreate, async i => {
  if (!i.isChatInputCommand() || i.commandName !== 'restore' || !i.guild) return;
  if (!i.memberPermissions.has(PermissionFlagsBits.Administrator)) return i.reply({ content: 'Admins only.', ephemeral: true });
  await i.deferReply({ ephemeral: true });
  const since = Date.now() - (i.options.getInteger('hours') ?? 24) * 3600e3;
  try {
    const log = await restore(i.guild, since, i.options.getBoolean('preview') ?? false);
    await i.editReply(log.join('\n').slice(0, 1900));
  } catch (err) { await i.editReply(`failed: ${err.message}`); }
});

// Render web services need an open port; bg workers ignore this.
http.createServer((_, r) => r.end('ok')).listen(process.env.PORT || 3000);
client.login(process.env.DISCORD_TOKEN);
