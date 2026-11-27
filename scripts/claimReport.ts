// Owner-only report on claim activity. Reads the database read-only and prints to the
// terminal; nothing here is exposed over the API because it contains client IPs.
//
//   bun run scripts/claimReport.ts [--db path/to/database.db] [--days 7]
//
// To act on what it shows (the server picks changes up within a minute):
//   Nothing is blacklisted automatically.
//   blacklist a hotkey:  INSERT INTO blacklist (kind, value, reason, source) VALUES ('hotkey', '<ss58>', '<why>', 'manual');
//   lift an entry:       DELETE FROM blacklist WHERE kind = '<hotkey|eth>' AND value = '<value>';
import { Database } from 'bun:sqlite';

const arg = (name: string, fallback: string) => { const i = process.argv.indexOf(`--${name}`); return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback; };
const days = Math.max(1, Number(arg('days', '7')) || 7);
const db = new Database(arg('db', 'database.db'), { readonly: true });
const since = `-${days} days`;
const all = (sql: string, ...p: any[]) => db.query(sql).all(...p) as any[];
const section = (title: string, rows: any[]) => { console.log(`\n== ${title} (${rows.length}) ==`); if (rows.length) console.table(rows); else console.log('  none'); };

section('Blacklist', all(`SELECT kind, value, source, reason, created_at FROM blacklist ORDER BY id DESC LIMIT 50`));

section(`Clients sending forged claims, last ${days} days`, all(`
    SELECT ip_key AS client, ip_trusted AS trusted, COUNT(*) AS forged, COUNT(DISTINCT ss58Address) AS targets,
           COUNT(DISTINCT ethereumAddress) AS wallets, MIN(created_at) AS first, MAX(created_at) AS last, MAX(user_agent) AS user_agent
    FROM claim_attempts WHERE outcome = 'forged_hotkey_sig' AND created_at >= datetime('now', ?)
    GROUP BY ip_key, ip_trusted ORDER BY forged DESC LIMIT 30`, since));

section(`Most targeted hotkeys, last ${days} days`, all(`
    SELECT ss58Address AS hotkey, COUNT(*) AS forged, COUNT(DISTINCT ip_key) AS clients, MAX(created_at) AS last
    FROM claim_attempts WHERE outcome = 'forged_hotkey_sig' AND created_at >= datetime('now', ?)
    GROUP BY ss58Address ORDER BY forged DESC LIMIT 20`, since));

section('Clients used by more than one hotkey for verified claims', all(`
    SELECT last_ip AS client, COUNT(DISTINCT ss58Address) AS hotkeys, GROUP_CONCAT(DISTINCT substr(ss58Address, 1, 8)) AS hotkey_prefixes, MAX(last_seen) AS last_seen
    FROM verified_claims WHERE last_ip IS NOT NULL AND last_ip != 'unknown' GROUP BY last_ip HAVING COUNT(DISTINCT ss58Address) > 1 ORDER BY hotkeys DESC LIMIT 30`));

section(`Mapping changes, last ${days} days`, all(`
    SELECT created_at, ss58Address AS hotkey, previous_eth AS from_wallet, ethereumAddress AS to_wallet, outcome, ip, substr(user_agent, 1, 20) AS user_agent
    FROM claim_attempts WHERE outcome IN ('mapping_created', 'mapping_updated') AND created_at >= datetime('now', ?)
    ORDER BY id DESC LIMIT 50`, since));

section(`Other rejected claims, last ${days} days`, all(`
    SELECT outcome, COUNT(*) AS n, COUNT(DISTINCT ip_key) AS clients, MAX(created_at) AS last
    FROM claim_attempts WHERE outcome NOT IN ('forged_hotkey_sig', 'mapping_created', 'mapping_updated') AND created_at >= datetime('now', ?)
    GROUP BY outcome`, since));
