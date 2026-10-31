# discord-restore-bot

`/restore [hours] [preview]` recreates roles and channels deleted in the last N hours (default 24) from the audit log. Safe to re-run: anything with a matching name already existing is skipped.

## Discord setup
1. discord.com/developers → New Application → Bot → copy token.
2. Invite with scopes `bot` + `applications.commands`, permissions: Manage Roles, Manage Channels, View Audit Log.
3. Drag the bot's role **above** the roles you want it to recreate/assign.

## Render
New → Background Worker (or Web Service) → connect this repo.
- Build: `npm install`
- Start: `npm start`
- Env var: `DISCORD_TOKEN`

Free Web Service sleeps; ping it with UptimeRobot, or you only need it awake while restoring.

## Limits
Messages are not recoverable. Audit log keeps ~45 days. Channel category placement and role order depend on what Discord logged; fix by hand if off.
