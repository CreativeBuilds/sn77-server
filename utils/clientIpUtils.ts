// ---------------------------------------------------------------------------
// Trustworthy client IP
//
// The API port is reachable without going through nginx/Cloudflare, and request
// headers are client-controlled, so a header is only believed when the party
// that set it is known:
//   - socket peer is NOT loopback  -> the request came straight to the app;
//     the socket address is the client. Headers are ignored.
//   - socket peer IS loopback      -> the request came through nginx, which
//     overwrites X-Real-IP with its own TCP peer.
//       - that peer is a Cloudflare edge -> CF-Connecting-IP is the client.
//       - otherwise                      -> that peer is the client.
// If any step cannot be established the result is marked untrusted and no
// IP-based conclusion is drawn from it.
// ---------------------------------------------------------------------------

// https://www.cloudflare.com/ips-v4 and /ips-v6 (checked 2026-11-27)
const CLOUDFLARE_RANGES = [
    '173.245.48.0/20', '103.21.244.0/22', '103.22.200.0/22', '103.31.4.0/22', '141.101.64.0/18', '108.162.192.0/18',
    '190.93.240.0/20', '188.114.96.0/20', '197.234.240.0/22', '198.41.128.0/17', '162.158.0.0/15', '104.16.0.0/13',
    '104.24.0.0/14', '172.64.0.0/13', '131.0.72.0/22',
    '2400:cb00::/32', '2606:4700::/32', '2803:f800::/32', '2405:b500::/32', '2405:8100::/32', '2a06:98c0::/29', '2c0f:f248::/32',
];

export type ParsedIp = { version: 4 | 6; value: bigint; text: string };
export type ClientIp = { ip: string; ipKey: string; trusted: boolean };

const parseV4 = (s: string): bigint | null => {
    const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
    if (!m) return null;
    const p = m.slice(1).map(Number);
    if (p.some(x => x > 255)) return null;
    return (BigInt(p[0]) << 24n) | (BigInt(p[1]) << 16n) | (BigInt(p[2]) << 8n) | BigInt(p[3]);
};

const parseV6 = (s: string): bigint | null => {
    if (s.length > 39 || !/^[0-9a-fA-F:]+$/.test(s)) return null;
    const halves = s.split('::');
    if (halves.length > 2) return null;
    const head = halves[0] ? halves[0].split(':') : [];
    const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
    let groups: string[];
    if (halves.length === 1) groups = head;
    else {
        const fill = 8 - head.length - tail.length;
        if (fill < 1) return null;
        groups = [...head, ...Array(fill).fill('0'), ...tail];
    }
    if (groups.length !== 8 || groups.some(g => !/^[0-9a-fA-F]{1,4}$/.test(g))) return null;
    return groups.reduce((acc, g) => (acc << 16n) | BigInt(parseInt(g, 16)), 0n);
};

const formatV6 = (value: bigint): string => {
    const g: string[] = [];
    for (let i = 7; i >= 0; i--) g.push(((value >> BigInt(i * 16)) & 0xffffn).toString(16));
    return g.join(':');
};

export const parseIp = (raw: unknown): ParsedIp | null => {
    let s = String(raw ?? '').trim();
    if (!s || s.length > 64) return null;
    if (s.toLowerCase().startsWith('::ffff:') && s.includes('.')) s = s.slice(7); // IPv4-mapped IPv6
    const v4 = parseV4(s);
    if (v4 !== null) return { version: 4, value: v4, text: s };
    const v6 = parseV6(s);
    if (v6 !== null) return { version: 6, value: v6, text: formatV6(v6) };
    return null;
};

export const ipInCidr = (ip: ParsedIp, cidr: string): boolean => {
    const [base, bitsStr] = cidr.split('/');
    const net = parseIp(base);
    const bits = Number(bitsStr);
    const width = ip.version === 4 ? 32 : 128;
    if (!net || net.version !== ip.version || !Number.isInteger(bits) || bits < 0 || bits > width) return false;
    const shift = BigInt(width - bits);
    return (ip.value >> shift) === (net.value >> shift);
};

const isLoopback = (ip: ParsedIp): boolean => (ip.version === 4 ? ipInCidr(ip, '127.0.0.0/8') : ip.value === 1n);
const isCloudflare = (ip: ParsedIp): boolean => CLOUDFLARE_RANGES.some(r => ipInCidr(ip, r));

// Grouping key for "same client": the address itself for IPv4, the /64 for IPv6
// (one subscriber normally holds a whole /64 and can rotate freely inside it).
export const ipKeyOf = (ip: ParsedIp): string =>
    ip.version === 4 ? ip.text : `${formatV6((ip.value >> 64n) << 64n).split(':').slice(0, 4).join(':')}::/64`;

const UNKNOWN: ClientIp = { ip: 'unknown', ipKey: 'unknown', trusted: false };
const known = (ip: ParsedIp): ClientIp => ({ ip: ip.text, ipKey: ipKeyOf(ip), trusted: true });

export const resolveClientIp = (a: { peer?: unknown; xRealIp?: unknown; cfConnectingIp?: unknown }): ClientIp => {
    const peer = parseIp(a.peer);
    if (!peer) return UNKNOWN;
    if (!isLoopback(peer)) return known(peer);          // direct connection: ignore all headers
    const viaProxy = parseIp(a.xRealIp);                // set by nginx from its TCP peer
    if (!viaProxy || isLoopback(viaProxy)) return UNKNOWN;
    if (!isCloudflare(viaProxy)) return known(viaProxy); // reached nginx without Cloudflare
    const cf = parseIp(a.cfConnectingIp);
    return cf ? known(cf) : UNKNOWN;                    // a Cloudflare edge address says nothing about the client
};
