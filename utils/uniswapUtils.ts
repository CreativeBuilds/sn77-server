/**
 * We need an api endpoint in @server.ts which is /positions and /positions/:minerUID
 *
 * then we will show all the uniswap v3 active liquidity positions that they have by going through the graph
 */

// A re-usable Result type for returning value/error pairs
export type Result<T> = [T, Error | null];

export interface SubgraphPosition {
    id: string;
    owner: string;
    liquidity: string;
    depositedToken0: string;
    depositedToken1: string;
    tickLower: {
        id: string;
        tickIdx: string;
    };
    tickUpper: {
        id: string;
        tickIdx: string;
    };
    token0: {
        id: string;
        symbol: string;
        name: string;
        decimals: string;
    };
    token1: {
        id: string;
        symbol: string;
        name: string;
        decimals: string;
    };
    pool: {
        id: string;
        feeTier: string;
        tick: string;
        token0Price: string;
        token1Price:string;
    };
}

export type LiquidityPosition = SubgraphPosition;

// By default, search all pools that have been voted on.
// This will be populated from the database.
const DEFAULT_POOLS: string[] = [];

/**
 * Fetch liquidity positions for the given miners from the Uniswap-V3 subgraph.
 */
export async function getMinerLiquidityPositions(minerAddresses: Record<string, string>, pools: string[] = DEFAULT_POOLS): Promise<Result<Record<string, LiquidityPosition[]>>> {
    const ethAddresses = Object.values(minerAddresses);
    if (ethAddresses.length === 0) return [{}, null];

    const apiKey = process.env.THEGRAPH_API_KEY;
    if (!apiKey) return [{}, new Error('THEGRAPH_API_KEY not configured')];

    const subgraphId = '5zvR82QoaXYFyDEKLZ9t6v9adgnptxYpKpSbxtgVENFV';
    const url = `https://gateway.thegraph.com/api/subgraphs/id/${subgraphId}`;

    // Ensure pool IDs are lowercase to match how The Graph stores addresses
    const poolIds = pools.map(p => p.toLowerCase());

    const addrToUid = new Map<string, string>();
    for (const [uid, addr] of Object.entries(minerAddresses)) addrToUid.set(addr.toLowerCase(), uid);

    const out: Record<string, LiquidityPosition[]> = {};
    const batchSize = 100;
    const limit = 1000;

    for (let i = 0; i < ethAddresses.length; i += batchSize) {
        const owners = ethAddresses.slice(i, i + batchSize).map(a => a.toLowerCase());
        const query = `query($owners:[String!]!,$pools:[String!]!,$limit:Int!){positions(first:$limit,where:{owner_in:$owners,liquidity_gt:"1",pool_:{id_in:$pools}}){id owner liquidity depositedToken0 depositedToken1 tickLower{id tickIdx} tickUpper{id tickIdx} token0{id symbol name decimals} token1{id symbol name decimals} pool{id feeTier tick token0Price token1Price}}}`;
        const r = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
            body: JSON.stringify({ query, variables: { owners, pools: poolIds, limit } })
        });
        const txt = await r.text();
        if (!r.ok) continue;
        const data = JSON.parse(txt);
        if (data.errors) continue;
        const positions: SubgraphPosition[] = data.data?.positions ?? [];
        for (const p of positions) {
            const uid = addrToUid.get(p.owner.toLowerCase());
            if (!uid) continue;
            if (!out[uid]) out[uid] = [];
            out[uid].push(p as LiquidityPosition);
        }
    }

    // ensure every miner key exists
    for (const uid of Object.keys(minerAddresses)) if (!out[uid]) out[uid] = [];
    return [out, null];
} 