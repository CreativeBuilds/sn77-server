import { verifyEthereumSignature } from './signatureUtils';
import { resolveClientIp } from './clientIpUtils';

// ---------------------------------------------------------------------------
// Claim audit log + manual blacklist
//
// Forged claims are rejected by verifySignature(). This module only RECORDS
// what happened so the subnet owner can review it (scripts/claimReport.ts):
//   - claim_attempts: every rejected claim and every mapping change, with the
//     client IP, user agent, signature, message and the wallet that was replaced.
//   - verified_claims: one row per (hotkey, wallet) pair that fully verified.
//
// Nothing is penalised automatically. A forged request names the VICTIM's
// hotkey, and an honest miner with a broken client looks the same as an
// attacker, so any automatic penalty can land on the wrong party.
//
// The blacklist table is written by hand only. Blacklisted hotkeys and wallets
// are skipped when miner positions are loaded (zero weight), and a blacklisted
// wallet cannot be mapped. Remove the row to lift it.
// Nothing in here may throw into a request handler: every export catches.
// ---------------------------------------------------------------------------

type Db = { exec: (sql: string) => Promise<any>; run: (sql: string, ...p: any[]) => Promise<any>; get: (sql: string, ...p: any[]) => Promise<any>; all: (sql: string, ...p: any[]) => Promise<any[]> };
export type BlacklistKind = 'hotkey' | 'eth';
export type RequestMeta = { ip: string; userAgent: string; ipKey?: string; ipTrusted?: boolean };

const CLAIM_LOG_RETENTION_DAYS = 90;
const clip = (s: unknown, n: number) => String(s ?? '').slice(0, n);
const norm = (kind: BlacklistKind, value: string) => (kind === 'eth' ? value.toLowerCase() : value);

export const initBlacklistTables = async (db: Db): Promise<void> => {
    await db.exec(`
        CREATE TABLE IF NOT EXISTS blacklist (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            kind TEXT NOT NULL CHECK (kind IN ('hotkey', 'eth')),
            value TEXT NOT NULL,
            reason TEXT NOT NULL,
            evidence TEXT,
            source TEXT NOT NULL DEFAULT 'auto',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            UNIQUE (kind, value)
        );
        CREATE TABLE IF NOT EXISTS claim_attempts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            ip TEXT,
            user_agent TEXT,
            ss58Address TEXT,
            ethereumAddress TEXT,
            hotkey_sig_ok INTEGER NOT NULL,
            eth_sig_ok INTEGER,
            outcome TEXT NOT NULL,
            previous_eth TEXT,
            signature TEXT,
            message TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_claim_attempts_hotkey ON claim_attempts (ss58Address);
        CREATE INDEX IF NOT EXISTS idx_claim_attempts_eth ON claim_attempts (ethereumAddress);
        CREATE INDEX IF NOT EXISTS idx_claim_attempts_created ON claim_attempts (created_at);
        CREATE TABLE IF NOT EXISTS verified_claims (
            ss58Address TEXT NOT NULL,
            ethereumAddress TEXT NOT NULL,
            first_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            last_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            claim_count INTEGER NOT NULL DEFAULT 1,
            last_ip TEXT,
            last_user_agent TEXT,
            PRIMARY KEY (ss58Address, ethereumAddress)
        );
        CREATE INDEX IF NOT EXISTS idx_verified_claims_eth ON verified_claims (ethereumAddress);
    `);
    // columns added after the first release of claim_attempts
    try { await db.exec('ALTER TABLE claim_attempts ADD COLUMN ip_key TEXT'); } catch (_) { }
    try { await db.exec('ALTER TABLE claim_attempts ADD COLUMN ip_trusted INTEGER'); } catch (_) { }
    try { await db.exec('CREATE INDEX IF NOT EXISTS idx_claim_attempts_ip_key ON claim_attempts (ip_key)'); } catch (_) { }
};

// Elysia hands us a web Request: headers must be read with .get(). `peerAddress` is the
// socket address from server.requestIP(request); without it the IP is recorded as untrusted.
export const getRequestMeta = (request: any, peerAddress?: unknown): RequestMeta => {
    const h = (name: string): string => {
        try { return request?.headers?.get?.(name) || ''; } catch { return ''; }
    };
    const client = resolveClientIp({ peer: peerAddress, xRealIp: h('x-real-ip'), cfConnectingIp: h('cf-connecting-ip') });
    return { ip: client.ip, ipKey: client.ipKey, ipTrusted: client.trusted, userAgent: clip(h('user-agent'), 200) };
};

export const isBlacklisted = async (db: Db, kind: BlacklistKind, value: string): Promise<boolean> => {
    try {
        return !!(await db.get('SELECT 1 FROM blacklist WHERE kind = ? AND value = ?', kind, norm(kind, value)));
    } catch (e) {
        console.error('[BLACKLIST] lookup failed:', e);
        return false;
    }
};

// Fails open: if the blacklist cannot be read, weights are computed as before.
export const getBlacklistSets = async (db: Db): Promise<{ hotkeys: Set<string>; eth: Set<string> }> => {
    const out = { hotkeys: new Set<string>(), eth: new Set<string>() };
    try {
        const rows = await db.all('SELECT kind, value FROM blacklist');
        for (const r of rows) (r.kind === 'hotkey' ? out.hotkeys : out.eth).add(r.value);
    } catch (e) {
        console.error('[BLACKLIST] could not load blacklist, continuing without it:', e);
    }
    return out;
};

export const getBlacklist = async (db: Db): Promise<any[]> => {
    try {
        return await db.all('SELECT kind, value, reason, source, created_at FROM blacklist ORDER BY id');
    } catch (e) {
        console.error('[BLACKLIST] list failed:', e);
        return [];
    }
};

export const recordClaimAttempt = async (db: Db, a: {
    meta: RequestMeta; hotkey: string; eth: string | null; hotkeySigOk: boolean; ethSigOk: boolean | null;
    outcome: string; previousEth?: string | null; signature: string; message: string;
}): Promise<void> => {
    try {
        await db.run(
            `INSERT INTO claim_attempts (ip, ip_key, ip_trusted, user_agent, ss58Address, ethereumAddress, hotkey_sig_ok, eth_sig_ok, outcome, previous_eth, signature, message)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            a.meta.ip, a.meta.ipKey ?? null, a.meta.ipTrusted ? 1 : 0, a.meta.userAgent,
            clip(a.hotkey, 100), a.eth ? clip(a.eth.toLowerCase(), 64) : null,
            a.hotkeySigOk ? 1 : 0, a.ethSigOk === null ? null : (a.ethSigOk ? 1 : 0), clip(a.outcome, 60),
            a.previousEth ?? null, clip(a.signature, 300), clip(a.message, 700),
        );
        if (Math.random() < 0.01) {
            await db.run(`DELETE FROM claim_attempts WHERE created_at < datetime('now', ?)`, `-${CLAIM_LOG_RETENTION_DAYS} days`);
        }
    } catch (e) {
        console.error('[CLAIM-LOG] could not record claim attempt:', e);
    }
};

// Called for every claim whose hotkey AND ETH signatures both verified.
export const recordVerifiedClaim = async (db: Db, hotkey: string, eth: string, meta: RequestMeta): Promise<void> => {
    try {
        await db.run(
            `INSERT INTO verified_claims (ss58Address, ethereumAddress, last_ip, last_user_agent) VALUES (?, ?, ?, ?)
             ON CONFLICT (ss58Address, ethereumAddress) DO UPDATE SET
                last_seen = CURRENT_TIMESTAMP, claim_count = claim_count + 1, last_ip = excluded.last_ip, last_user_agent = excluded.last_user_agent`,
            hotkey, eth.toLowerCase(), meta.ip, meta.userAgent,
        );
    } catch (e) {
        console.error('[CLAIM-LOG] could not record verified claim:', e);
    }
};

// Log-only forensic pass over a claim whose hotkey signature did NOT verify (the request has
// already been rejected). Outcome 'forged_hotkey_sig' means the wallet's ETH signature was valid
// for a hotkey not mapped to it, i.e. the shape of the claim-takeover attack. Never throws.
export const logFailedHotkeySignature = async (db: Db, a: {
    meta: RequestMeta; hotkey: string; signature: string; message: string;
}): Promise<{ outcome: string; eth: string | null }> => {
    const result = { outcome: 'bad_hotkey_sig', eth: null as string | null };
    try {
        const parts = String(a.message).split('|');
        let ethSigOk: boolean | null = null;
        let previousEth: string | null = null;

        if (parts.length === 5) {
            const [ethSig, ethAddrPayload, hotkeyPayload, blockNumStr, ethSigner] = parts;
            const wellFormed = /^0x[a-fA-F0-9]{40}$/.test(ethSigner)
                && ethAddrPayload.toLowerCase() === ethSigner.toLowerCase()
                && hotkeyPayload === a.hotkey;
            if (wellFormed) {
                result.eth = ethSigner.toLowerCase();
                ethSigOk = verifyEthereumSignature(`${ethAddrPayload}|${hotkeyPayload}|${blockNumStr}`, ethSig, ethSigner).success;
                const current = await db.get('SELECT ethereumAddress FROM address_map WHERE ss58Address = ?', a.hotkey);
                previousEth = current?.ethereumAddress ? String(current.ethereumAddress).toLowerCase() : null;
                if (ethSigOk && previousEth !== result.eth) {
                    result.outcome = 'forged_hotkey_sig';
                    console.warn(`[CLAIM-LOG] rejected forged claim: hotkey=${a.hotkey} wallet=${result.eth} ip=${a.meta.ip} trusted=${!!a.meta.ipTrusted}`);
                }
            }
        }

        await recordClaimAttempt(db, {
            meta: a.meta, hotkey: a.hotkey, eth: result.eth, hotkeySigOk: false, ethSigOk, outcome: result.outcome,
            previousEth, signature: a.signature, message: a.message,
        });
    } catch (e) {
        console.error('[CLAIM-LOG] forensic logging failed:', e);
    }
    return result;
};
