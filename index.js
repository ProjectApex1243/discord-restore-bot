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

const cleanupCmd = new SlashCommandBuilder()
  .setName('cleanup')
  .setDescription('Delete what a raider created and/or channels with certain words in the name')
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addUserOption(o => o.setName('user').setDescription('The raider (user or bot)'))
  .addStringOption(o => o.setName('names').setDescription('Delete channels whose name has any of these words, comma separated'))
  .addIntegerOption(o => o.setName('hours').setDescription('How far back to look (default 24)').setMinValue(1).setMaxValue(1080))
  .addBooleanOption(o => o.setName('confirm').setDescription('Actually delete. Without this it only counts'));

const sortCmd = new SlashCommandBuilder()
  .setName('sort')
  .setDescription('Move channels with a year in the name (23, 24, 2025...) into the matching year category')
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addBooleanOption(o => o.setName('preview').setDescription('List the moves, change nothing'));

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

  // Oldest rename in the window holds the pre-raid name.
  const rename = (await fetchAll(guild, AuditLogEvent.GuildUpdate, since))
    .map(e => e.changes.find(c => c.key === 'name')).find(Boolean);
  if (rename && rename.old !== guild.name) {
    if (preview) log.push(`would rename server to **${rename.old}**`);
    else {
      try { await guild.setName(rename.old); log.push(`server name → **${rename.old}** ✅`); }
      catch (err) { log.push(`server name ❌ ${err.message}`); }
    }
  }

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

// Deletes channels/roles whose audit-log creator is `userId`. Counts only unless `confirm`.
// Raiders often use fancy-font names; fold small caps / math fonts to plain a-z so keywords match.
const SMALL_CAPS = Object.fromEntries([...'ᴀʙᴄᴅᴇꜰɢʜɪᴊᴋʟᴍɴᴏᴘꞯʀꜱᴛᴜᴠᴡxʏᴢ'].map((c, i) => [c, 'abcdefghijklmnopqrstuvwxyz'[i]]));
const plain = s => [...s.normalize('NFKD').toLowerCase()].map(c => SMALL_CAPS[c] ?? c).join('');

async function cleanupBy(guild, userId, names, since, confirm) {
  await guild.roles.fetch();
  await guild.channels.fetch();
  const victims = new Map(); // id -> channel/role
  if (userId) {
    const created = [
      ...(await fetchAll(guild, AuditLogEvent.ChannelCreate, since)).map(e => [e, guild.channels.cache]),
      ...(await fetchAll(guild, AuditLogEvent.RoleCreate, since)).map(e => [e, guild.roles.cache]),
    ];
    for (const [e, cache] of created) {
      const t = cache.get(e.targetId);
      if (e.executorId === userId && t) victims.set(t.id, t);
    }
  }
  const words = (names ?? '').split(',').map(w => plain(w.trim())).filter(Boolean);
  if (words.length) {
    for (const c of guild.channels.cache.values()) if (words.some(w => plain(c.name).includes(w))) victims.set(c.id, c);
  }
  if (!confirm) {
    const sample = [...victims.values()].slice(0, 15).map(t => t.name).join(', ');
    return [`would delete ${victims.size} channels/roles`, sample];
  }
  const fails = [];
  for (const t of victims.values()) {
    try { await t.delete('raid cleanup'); } catch (err) { fails.push(`${t.name} ❌ ${err.message}`); }
  }
  return [`deleted ${victims.size - fails.length} channels/roles`, ...fails];
}

// "spring-26" / "halloween-2024" -> category whose name has 26 / 2024 (years 2020-2029 only).
const YEAR = /(?<!\d)(?:20)?(2\d)(?!\d)/;

async function sortByYear(guild, preview) {
  await guild.channels.fetch();
  const cats = new Map(); // "26" -> category
  for (const c of guild.channels.cache.values()) {
    const y = c.type === ChannelType.GuildCategory && plain(c.name).match(YEAR)?.[1];
    if (y && !cats.has(y)) cats.set(y, c);
  }
  const log = [];
  let moved = 0;
  for (const c of guild.channels.cache.values()) {
    if (c.type === ChannelType.GuildCategory || c.isThread()) continue;
    const cat = cats.get(plain(c.name).match(YEAR)?.[1]);
    if (!cat || c.parentId === cat.id) continue;
    if (preview) { log.push(`#${c.name} → ${cat.name}`); continue; }
    try { await c.setParent(cat, { lockPermissions: false }); moved++; }
    catch (err) { log.push(`#${c.name} ❌ ${err.message}`); }
  }
  const head = preview ? `would move ${log.length} channels` : `moved ${moved} channels`;

  // Non-year categories keep their order on top; year categories follow, newest first.
  const cs = [...guild.channels.cache.filter(c => c.type === ChannelType.GuildCategory).values()]
    .sort((a, b) => a.rawPosition - b.rawPosition);
  const yr = c => Number(plain(c.name).match(YEAR)?.[1]);
  const order = [...cs.filter(c => !yr(c)), ...cs.filter(yr).sort((a, b) => yr(b) - yr(a))];
  if (order.some((c, i) => c !== cs[i])) {
    if (preview) log.push(`categories → ${order.map(c => c.name).join(' › ')}`);
    else {
      try {
        await guild.channels.setPositions(order.map((c, i) => ({ channel: c.id, position: cs[i].rawPosition })));
        log.push('categories reordered ✅');
      } catch (err) { log.push(`category order ❌ ${err.message}`); }
    }
  }
  return [head, ...log];
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });
const register = g => g.commands.set([command, cleanupCmd, sortCmd].map(c => c.toJSON())).catch(console.error);

client.once(Events.ClientReady, c => { console.log(`up as ${c.user.tag}`); c.guilds.cache.forEach(register); });
client.on(Events.GuildCreate, register);

client.on(Events.InteractionCreate, async i => {
  if (!i.isChatInputCommand() || !['restore', 'cleanup', 'sort'].includes(i.commandName) || !i.guild) return;
  if (!i.memberPermissions.has(PermissionFlagsBits.Administrator)) return i.reply({ content: 'Admins only.', ephemeral: true });
  const user = i.options.getUser('user');
  if (user && (user.id === client.user.id || user.id === i.guild.ownerId)) {
    return i.reply({ content: "Can't target the bot or the server owner.", ephemeral: true });
  }
  const names = i.options.getString('names');
  if (i.commandName === 'cleanup' && !user && !names) {
    return i.reply({ content: 'Give a `user` and/or `names`.', ephemeral: true });
  }
  await i.deferReply({ ephemeral: true });
  const since = Date.now() - (i.options.getInteger('hours') ?? 24) * 3600e3;
  try {
    const preview = i.options.getBoolean('preview') ?? false;
    const log = i.commandName === 'cleanup'
      ? await cleanupBy(i.guild, user?.id, names, since, i.options.getBoolean('confirm') ?? false)
      : i.commandName === 'sort'
        ? await sortByYear(i.guild, preview)
        : await restore(i.guild, since, preview);
    await i.editReply(log.join('\n').slice(0, 1900));
  } catch (err) { await i.editReply(`failed: ${err.message}`); }
});

// Render web services need an open port; bg workers ignore this.
http.createServer((_, r) => r.end('ok')).listen(process.env.PORT || 3000);
client.login(process.env.DISCORD_TOKEN);
