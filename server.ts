import { Elysia } from 'elysia';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import { ethers } from 'ethers';
import { fetchCurrentBittensorBlock, closeBittensorConnection } from './utils/bittensorUtils';
import { initializeSubnetHotkeysCache, startPeriodicSubnetHotkeysRefresh, stopPeriodicSubnetHotkeysRefresh, getSubnetHotkeys } from './utils/bittensorUtils';
import { readFileSync } from 'fs';

// Shared utils
import { sanitizeError } from './utils/errorUtils';
import { checkRateLimit, getClientIP } from './utils/rateLimitUtils';
import { validateBasicInput, normalizeWeights } from './utils/validationUtils';
import { verifySignature, verifyEthereumSignature } from './utils/signatureUtils';
import { initializeHoldersCache, startPeriodicHoldersRefresh, stopPeriodicHoldersRefresh, getHolders } from './utils/holdersUtils';
import { getAddressMapping, setAddressMapping, upsertUserVotes, getUserVotes, getPoolInfo, getAllPoolAddresses } from './utils/dbUtils';
import { validateUniswapV3Pools } from './utils/poolValidationUtils';
import { validateAndStorePoolInfo, getOrFetchPoolInfo } from './utils/enhancedPoolUtils';
import { getMinerLiquidityPositions, enhancePositionsWithUSDValues } from './utils/uniswapUtils';
import type { LiquidityPosition } from './utils/uniswapUtils';
import { 
    checkVoteCooldown, 
    recordVoteChange,
    cleanupExpiredCooldowns,
    checkVoteCooldownStatus
} from './utils/voteCooldownUtils';

// Rate limiting storage
const ipRequestCounts = new Map<string, { count: number; resetTime: number }>();
const addressRequestCounts = new Map<string, { count: number; resetTime: number }>();

// Rate limiting cleanup
setInterval(() => {
    const now = Date.now();
    
    for (const [ip, data] of ipRequestCounts.entries()) {
        if (now > data.resetTime) ipRequestCounts.delete(ip);
    }
    
    for (const [address, data] of addressRequestCounts.entries()) {
        if (now > data.resetTime) addressRequestCounts.delete(address);
    }
}, 5 * 60 * 1000); // Clean every 5 minutes

// Cooldown cleanup
setInterval(async () => {
    try {
        const [success, error] = await cleanupExpiredCooldowns(db);
        if (!success) console.error('Failed to cleanup expired cooldowns:', error);
    } catch (error) {
        console.error('Error during cooldown cleanup:', error);
    }
}, 60 * 60 * 1000); // Clean every hour

// Rate limiting configuration
const MAX_REQUESTS_PER_IP = 30; // 30 requests per minute per IP
const MAX_REQUESTS_PER_ADDRESS = 10; // 10 requests per minute per address
const MAX_VOTE_UPDATES_PER_ADDRESS = 5; // 5 vote updates per minute per address



// Request size limits
const MAX_MESSAGE_LENGTH = 10000;
const MAX_SIGNATURE_LENGTH = 1000;
const MAX_ADDRESS_LENGTH = 100;
const MAX_POOLS_PER_REQUEST = 10; // Changed from 100 to 10 pools max
const VOTE_WEIGHT_TOTAL = 10000; // Total weight should sum to 10000

const db = await open({
    filename: 'database.db',
    driver: sqlite3.Database,
});

await db.exec(`
  CREATE TABLE IF NOT EXISTS address_map (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ss58Address TEXT NOT NULL UNIQUE,
    ethereumAddress TEXT NOT NULL UNIQUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS user_votes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ss58Address TEXT NOT NULL UNIQUE,
    pools TEXT NOT NULL,
    signature TEXT NOT NULL,
    message TEXT NOT NULL,
    block_number INTEGER NOT NULL,
    total_weight REAL NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS pool_info (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    address TEXT NOT NULL UNIQUE,
    token0 TEXT NOT NULL,
    token1 TEXT NOT NULL,
    token0Symbol TEXT,
    token1Symbol TEXT,
    fee INTEGER NOT NULL,
    liquidity TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS vote_change_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ss58Address TEXT NOT NULL,
    old_pools TEXT,
    new_pools TEXT,
    change_timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    cooldown_until TIMESTAMP,
    change_count INTEGER DEFAULT 1
  )
`);

// add column safely when DB already existed without it
try { await db.exec('ALTER TABLE votes ADD COLUMN block_number INTEGER DEFAULT 0'); } catch (_) { }
try { await db.exec('ALTER TABLE pool_info ADD COLUMN liquidity TEXT'); } catch (_) { }

// Add vote change history table safely
try { 
    await db.exec(`
        CREATE TABLE IF NOT EXISTS vote_change_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            ss58Address TEXT NOT NULL,
            old_pools TEXT,
            new_pools TEXT,
            change_timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            cooldown_until TIMESTAMP,
            change_count INTEGER DEFAULT 1
        )
    `); 
} catch (_) { }

const BLOCK_WINDOW = 10; // max allowed difference between submitted and current chain block
const VOTES_CACHE_TTL_MS = 30 * 1000; // refresh every 30s to reduce DB load when /allVotes is spammed
let votesCache: { data: any; lastUpdated: number } = { data: null, lastUpdated: 0 };
const LIQUIDITY_POSITIONS_CACHE_TTL_MS = 1 * 60 * 1000; // 1 minute
let liquidityPositionsCache: { data: Record<string, LiquidityPosition[]> | null; lastUpdated: number } = { data: null, lastUpdated: 0 };

// holders refresh interval managed in utils

// Initialize Ethereum provider
const provider = new ethers.JsonRpcProvider(process.env.ETH_RPC_URL || 'https://eth.llamarpc.com');

const GAUSSIAN_AMPLITUDE = 10; // 'a' parameter
const FEE_TIER_STD_DEVS: Record<string, number> = {
    "100": 10,    // 0.01% (Stable-Stable)
    "500": 50,    // 0.05% (Stable-Major)
    "3000": 200,  // 0.3% (Standard)
    "10000": 500, // 1% (Volatile)
};
const DEFAULT_STD_DEV = FEE_TIER_STD_DEVS["3000"]; // Default to 0.3%
const LIQUIDITY_NORMALIZATION_FACTOR = 1e9; // Adjust based on typical liquidity scales

interface PositionScore {
    gaussianMultiplier: number;
    liquidityAmount: number;
    finalScore: number;
    poolId: string;
    pairKey: string;
}

// Helper function to check if a position is valid (current tick is within position bounds)
function isValidPosition(position: LiquidityPosition): boolean {
    if (!position.pool) return false;
    
    const currentTickStr = position.pool.tick;
    if (typeof currentTickStr === 'undefined' || currentTickStr === null) return false;
    
    const currentTick = Number(currentTickStr);
    if (isNaN(currentTick)) return false;
    
    if (typeof position.tickLower?.tickIdx === 'undefined' || position.tickLower.tickIdx === null) return false;
    if (typeof position.tickUpper?.tickIdx === 'undefined' || position.tickUpper.tickIdx === null) return false;
    
    const tickLower = Number(position.tickLower.tickIdx);
    const tickUpper = Number(position.tickUpper.tickIdx);
    
    if (isNaN(tickLower) || isNaN(tickUpper)) return false;
    if (tickLower >= tickUpper) return false;
    
    // Position is valid if current tick is within the position's range
    return currentTick > tickLower && currentTick < tickUpper;
}

function gaussianScore(distance: number, a: number = GAUSSIAN_AMPLITUDE, c: number = DEFAULT_STD_DEV): number {
    if (c <= 0) {
        console.warn(`Invalid standard deviation (c=${c}) in gaussianScore, returning 0.`);
        return 0;
    }
    return a * Math.exp(-(distance ** 2) / (2 * (c ** 2)));
}

function calculatePositionScore(position: LiquidityPosition, currentTick: number): PositionScore {
    if (!position.pool) {
        console.warn(`Cannot calculate score for position ${position.id}: missing pool data.`);
        return { gaussianMultiplier: 0, liquidityAmount: 0, finalScore: 0, poolId: "", pairKey: "" };
    }
    if (typeof position.tickLower?.tickIdx === 'undefined' || position.tickLower.tickIdx === null) { 
        console.warn(`Cannot calculate score for position ${position.id}: missing tickLower.tickIdx.`);
        return { gaussianMultiplier: 0, liquidityAmount: 0, finalScore: 0, poolId: "", pairKey: "" };
    }
    if (typeof position.tickUpper?.tickIdx === 'undefined' || position.tickUpper.tickIdx === null) { 
        console.warn(`Cannot calculate score for position ${position.id}: missing tickUpper.tickIdx.`);
        return { gaussianMultiplier: 0, liquidityAmount: 0, finalScore: 0, poolId: "", pairKey: "" };
    }
    if (typeof position.liquidity === 'undefined' || position.liquidity === null) {
        console.warn(`Cannot calculate score for position ${position.id}: missing liquidity.`);
         return { gaussianMultiplier: 0, liquidityAmount: 0, finalScore: 0, poolId: "", pairKey: "" };
    }

    const tickLower = Number(position.tickLower.tickIdx);
    const tickUpper = Number(position.tickUpper.tickIdx);
    const liquidityRaw = Number(position.liquidity);
    const poolId = position.pool.id;
    const pairKey = position.token0.id < position.token1.id ? `${position.token0.id}-${position.token1.id}` : `${position.token1.id}-${position.token0.id}`;

    if (isNaN(tickLower) || isNaN(tickUpper) || isNaN(liquidityRaw) || isNaN(currentTick)) {
         console.warn(`Cannot calculate score for position ${position.id}: invalid numeric data (tickLower=${position.tickLower.tickIdx}, tickUpper=${position.tickUpper.tickIdx}, liquidity=${position.liquidity}, or currentTick=${currentTick}).`);
         return { gaussianMultiplier: 0, liquidityAmount: 0, finalScore: 0, poolId: poolId, pairKey: pairKey };
    }

    if (tickLower >= tickUpper) {
        console.warn(`Cannot calculate score for position ${position.id}: tickLower (${tickLower}) must be less than tickUpper (${tickUpper}).`);
        return { gaussianMultiplier: 0, liquidityAmount: 0, finalScore: 0, poolId: poolId, pairKey: pairKey };
    }

    // If the current tick is outside the position's range, the position is inactive and should have no score.
    if (currentTick <= tickLower || currentTick >= tickUpper) {
        return { gaussianMultiplier: 0, liquidityAmount: 0, finalScore: 0, poolId: poolId, pairKey: pairKey };
    }

    const feeTier = position.pool.feeTier;
    const stdDev = FEE_TIER_STD_DEVS[feeTier] ?? DEFAULT_STD_DEV;

    const midPoint = (tickLower + tickUpper) / 2;

    const distanceLower = Math.abs(currentTick - tickLower);
    const distanceUpper = Math.abs(currentTick - tickUpper);
    const distanceMid = Math.abs(currentTick - midPoint);

    const scoreLower = gaussianScore(distanceLower, GAUSSIAN_AMPLITUDE, stdDev);
    const scoreUpper = gaussianScore(distanceUpper, GAUSSIAN_AMPLITUDE, stdDev);
    const scoreMid = gaussianScore(distanceMid, GAUSSIAN_AMPLITUDE, stdDev);

    const averageGaussianMultiplier = (scoreLower + 4 * scoreMid + scoreUpper) / 6;

    const liquidityAmount = liquidityRaw / LIQUIDITY_NORMALIZATION_FACTOR;

    const finalScore = averageGaussianMultiplier * liquidityAmount;

    return {
        gaussianMultiplier: averageGaussianMultiplier,
        liquidityAmount,
        finalScore,
        poolId: poolId,
        pairKey: pairKey
    };
}

// ---------------------------------------------------------------------------
// Emission Calculation Helper
// ---------------------------------------------------------------------------
const calculatePoolEmissions = async (): Promise<Map<string, number>> => {
    const rows = await db.all('SELECT ss58Address, pools FROM user_votes');
    const votes = rows.map((r: any) => ({ ...r, pools: JSON.parse(r.pools) }));
    
    const holders = getHolders() || [];
    interface Holder {
        address: string;
        alphaBalanceRaw: string;
    }
    const holderMap = new Map<string, number>(holders.map((h: Holder) => [h.address, parseFloat(h.alphaBalanceRaw || '0')]));
    
    // Filter out voters who don't hold any alpha tokens
    const validVotes = votes.filter(vote => {
        const balance = holderMap.get(vote.ss58Address) || 0;
        return balance > 0;
    });
    
    const totalAlphaTokens = validVotes.reduce((sum: number, vote) => {
        const balance = holderMap.get(vote.ss58Address) || 0;
        return sum + balance;
    }, 0);

    const weightedVotes = validVotes.map(vote => {
        const balance: number = holderMap.get(vote.ss58Address) || 0;
        const weightMultiplier: number = totalAlphaTokens > 0 ? balance / totalAlphaTokens : 0;
        return { ...vote, weightMultiplier };
    });

    const poolWeights = new Map<string, number>();
    weightedVotes.forEach(vote => {
        vote.pools.forEach((pool: any) => {
            const poolAddress = pool.address.toLowerCase();
            const currentWeight = poolWeights.get(poolAddress) || 0;
            const weightedContribution = pool.weight * vote.weightMultiplier;
            poolWeights.set(poolAddress, currentWeight + weightedContribution);
        });
    });

    const emissionMap = new Map<string, number>();
    for (const [poolAddress, totalWeight] of poolWeights.entries()) {
        emissionMap.set(poolAddress, totalWeight / VOTE_WEIGHT_TOTAL);
    }
    
    return emissionMap;
}

// ---------------------------------------------------------------------------
// Active Pool Fetching Helper
// ---------------------------------------------------------------------------
async function getActivePoolAddresses(db: any): Promise<string[]> {
    const rows = await db.all('SELECT ss58Address, pools FROM user_votes');
    const votes = rows.map((r: any) => ({ ss58Address: r.ss58Address, pools: JSON.parse(r.pools) }));
    
    const holders = getHolders() || [];
    interface Holder {
        address: string;
        alphaBalanceRaw: string;
    }
    const holderMap = new Map<string, number>(holders.map((h: Holder) => [h.address, parseFloat(h.alphaBalanceRaw || '0')]));

    const activePools = new Set<string>();

    votes.forEach((vote: { ss58Address: string; pools: any[] }) => {
        const balance = holderMap.get(vote.ss58Address) || 0;
        if (balance > 0) {
            vote.pools.forEach((pool: any) => {
                activePools.add(pool.address.toLowerCase());
            });
        }
    });

    return Array.from(activePools);
}

// ---------------------------------------------------------------------------
// Position Fetching Helper
// ---------------------------------------------------------------------------
async function getMinerPositions(db: any): Promise<[Record<string, LiquidityPosition[]>, boolean]> {
    let fromCache = false;
    let positionsByMiner: Record<string, LiquidityPosition[]> | null = null;

    if (liquidityPositionsCache.data && (Date.now() - liquidityPositionsCache.lastUpdated < LIQUIDITY_POSITIONS_CACHE_TTL_MS)) {
        positionsByMiner = liquidityPositionsCache.data;
        fromCache = true;
    } else {
        const hotkeys = getSubnetHotkeys();
        const rows = await db.all('SELECT ss58Address, ethereumAddress FROM address_map');
        const minerAddresses: Record<string, string> = {};
        for (const row of rows) {
            if (hotkeys.includes(row.ss58Address)) {
                minerAddresses[row.ss58Address] = row.ethereumAddress;
            }
        }

        const [pools, poolsErr] = await getAllPoolAddresses(db);
        if (poolsErr) throw new Error(`DB error: ${poolsErr}`);

        const [fetchedPositions, positionsErr] = await getMinerLiquidityPositions(minerAddresses, pools || []);
        if (positionsErr) throw positionsErr;
        if (!fetchedPositions) throw new Error('Fetched positions are null');

        // Filter out invalid positions (positions where current tick is outside bounds) before caching
        const filteredPositions: Record<string, LiquidityPosition[]> = {};
        for (const minerId in fetchedPositions) {
            filteredPositions[minerId] = (fetchedPositions[minerId] || []).filter(position => isValidPosition(position));
        }

        // Enhance positions with USD values
        const [enhancedPositions, usdErr] = await enhancePositionsWithUSDValues(filteredPositions);
        if (usdErr) {
            console.warn(`Failed to enhance positions with USD values: ${usdErr}`);
            // Continue with positions without USD values rather than failing
            positionsByMiner = filteredPositions;
        } else {
            positionsByMiner = enhancedPositions;
        }
        
        liquidityPositionsCache = { data: positionsByMiner, lastUpdated: Date.now() };
        fromCache = false;
    }
    
    const activePools = await getActivePoolAddresses(db);
    const activePoolsSet = new Set(activePools);

    const activePositionsByMiner: Record<string, LiquidityPosition[]> = {};

    if (positionsByMiner) {
        for (const minerId in positionsByMiner) {
            activePositionsByMiner[minerId] = (positionsByMiner[minerId] || []).filter(position => 
                activePoolsSet.has(position.pool.id.toLowerCase())
            );
        }
    }

    return [activePositionsByMiner, fromCache];
}

// ---------------------------------------------------------------------------
// Holders cache helpers
// ---------------------------------------------------------------------------

const app = new Elysia()
    .get('/', () => {
        return {
            message: "Welcome to the API. See available endpoints below:",
            endpoints: [
                {
                    path: "/updateVotes",
                    method: "POST",
                    description: "Updates or registers votes for a given coldkey address. The coldkey must hold alpha tokens. Includes vote cooldown management to prevent gaming of the incentive mechanism.",
                    inputs: {
                        body: {
                            signature: "string (Polkadot/Substrate signature of the message)",
                            message: "string (formatted as 'poolsStr|blockNumStr')",
                            address: "string (coldkey address of the voter)"
                        },
                        message_format_details: {
                            poolsStr: "string (formatted as 'poolAddress1,weight1;poolAddress2,weight2;...') - max 10 pools",
                            blockNumStr: "string (current Bittensor block number)"
                        }
                    },
                    outputs: {
                        success: "boolean",
                        message: "string (e.g., 'Votes updated')",
                        pools: "Array<{ address: string, weight: number }> (normalized pools if successful)",
                        error: "string (description of error if success is false)"
                    },
                    cooldown_features: {
                        base_cooldown: "72 minutes after vote changes",
                        progressive_system: "Cooldown doubles for frequent changes (72m → 144m → 288m → 576m)",
                        max_cooldown: "8 hours maximum cooldown cap",
                        cooldown_reset: "24 hours of inactivity resets change count back to 72m",
                        enhanced_errors: "Detailed error messages show remaining cooldown time and exact unlock time",
                        first_time_voting: "No cooldown for new voters"
                    }
                },
                {
                    path: "/claimAddress",
                    method: "POST",
                    description: "Claims an Ethereum address for a hotkey address. The hotkey must be registered in the subnet and hold alpha tokens.",
                    inputs: {
                        body: {
                            signature: "string (Polkadot/Substrate signature of the message)",
                            message: "string (formatted as 'ethSig|ethAddrPayload|hotkeyPayload|blockNumStr|ethSigner')",
                            address: "string (hotkey address)"
                        },
                        message_format_details: {
                            ethSig: "string (Ethereum signature of 'ethAddrPayload|hotkeyPayload|blockNumStr')",
                            ethAddrPayload: "string (Ethereum address being claimed)",
                            hotkeyPayload: "string (hotkey address performing the claim)",
                            blockNumStr: "string (current Bittensor block number)",
                            ethSigner: "string (Ethereum address that signed the ethMessage)"
                        }
                    },
                    outputs: {
                        success: "boolean",
                        message: "string (e.g., 'Address mapping created' or 'Mapping already exists')",
                        error: "string (description of error if success is false)"
                    }
                },
                {
                    path: "/userVotes/:address",
                    method: "GET",
                    description: "Retrieves the votes for a specific coldkey address.",
                    inputs: {
                        params: {
                            address: "string (coldkey address)"
                        }
                    },
                    outputs: {
                        success: "boolean",
                        userVotes: "object (contains user's vote data) or null if no votes found",
                        message: "string (e.g., 'No votes found')",
                        error: "string (description of error if success is false)"
                    }
                },
                {
                    path: "/allVotes",
                    method: "GET",
                    description: "Retrieves all stored user votes with token-based weight multipliers. Only includes voters who hold alpha tokens (filters out users with zero alpha balance). Results are cached for 30 seconds.",
                    inputs: "None",
                    outputs: {
                        success: "boolean",
                        votes: "Array<object> (list of all votes from alpha token holders, each containing: coldkey address, pools, total_weight, block_number, alphaBalance, weightMultiplier)",
                        totalAlphaTokens: "number (total alpha tokens held by all valid voters)",
                        cached: "boolean (true if the response is from cache)",
                        error: "string (description of error if success is false)"
                    },
                    filtering: {
                        alpha_holders_only: "Only voters who hold alpha tokens are included in the response",
                        zero_balance_excluded: "Users with zero alpha token balance are automatically filtered out"
                    },
                    weight_calculation: {
                        single_voter: "If only one valid voter exists, they receive full weight (weightMultiplier = 1)",
                        multiple_voters: "Weight multiplier is calculated as: voter's_alpha_tokens / total_alpha_tokens"
                    }
                },
                {
                    path: "/allHolders",
                    method: "GET",
                    description: "Retrieves all token holders and their balances directly from the Bittensor chain. Results are cached and periodically refreshed.",
                    inputs: "None",
                    outputs: {
                        success: "boolean",
                        holders: "object (mapping of coldkey address to balance)",
                        cached: "boolean (always true as data is served from an in-memory cache)",
                        error: "string (description of error if success is false)"
                    }
                },
                {
                    path: "/allAddresses",
                    method: "GET",
                    description: "Retrieves all addresses associated with the token holders.",
                    inputs: "None",
                    outputs: {
                        success: "boolean",
                        addresses: "Array<{ hotkeyAddress: string, ethereumAddress: string }> (linked addresses registered to subnet)",
                        error: "string (description of error if success is false)"
                    }
                },
                {
                    path: "/allMiners",
                    method: "GET",
                    description: "Retrieves all miners on the subnet along with their linked Ethereum addresses (if any).",
                    inputs: "None",
                    outputs: {
                        success: "boolean",
                        miners: "Array<{ hotkeyAddress: string, ethereumAddress: string | null }> (all subnet miners with optional Ethereum addresses)",
                        totalMiners: "number (total number of miners on the subnet)",
                        linkedMiners: "number (number of miners with linked Ethereum addresses)",
                        error: "string (description of error if success is false)"
                    }
                },
                {
                    path: "/pools",
                    method: "GET",
                    description: "Retrieves all incentivized pools with voting information and alpha token holdings for each voter. Only shows pools that have at least one active voter (voter holding alpha tokens).",
                    inputs: "None",
                    outputs: {
                        success: "boolean",
                        pools: "Array<{ address: string, totalWeight: number, token0: string, token1: string, token0Symbol: string, token1Symbol: string, fee: number, voters: Array<{ address: string, weight: number, alphaBalance: number, weightMultiplier: number }> }> (all pools being voted for with voter details and pool information)",
                        totalPools: "number (total number of unique pools being voted for)",
                        totalVoters: "number (total number of unique voters with alpha tokens)",
                        totalAlphaTokens: "number (total alpha tokens held by all valid voters)",
                        cached: "boolean (true if the response is from cache)",
                        error: "string (description of error if success is false)"
                    },
                    filtering: {
                        active_voters_only: "Only pools with at least one voter holding alpha tokens are included",
                        inactive_pools: "Pools where all voters have 0 alpha tokens are filtered out"
                    }
                },
                {
                    path: "/pools",
                    method: "GET",
                    description: "Retrieves all incentivized pools with voting information and alpha token holdings for each voter. Only shows pools that have at least one active voter (voter holding alpha tokens).",
                    inputs: "None",
                    outputs: {
                        success: "boolean",
                        pools: "Array<{ address: string, totalWeight: number, token0: string, token1: string, token0Symbol: string, token1Symbol: string, fee: number, voters: Array<{ address: string, weight: number, alphaBalance: number, weightMultiplier: number }> }> (all pools being voted for with voter details and pool information)",
                        totalPools: "number (total number of unique pools being voted for)",
                        totalVoters: "number (total number of unique voters with alpha tokens)",
                        totalAlphaTokens: "number (total alpha tokens held by all valid voters)",
                        cached: "boolean (true if the response is from cache)",
                        error: "string (description of error if success is false)"
                    },
                    filtering: {
                        active_voters_only: "Only pools with at least one voter holding alpha tokens are included",
                        inactive_pools: "Pools where all voters have 0 alpha tokens are filtered out"
                    }
                },
                {
                    path: "/positions",
                    method: "GET",
                    description: "Retrieves all active Uniswap v3 liquidity positions for all miners with a linked Ethereum address. Results are cached for 5 minutes. Can be filtered by `hotkey` and/or `pool`. Inactive liquidity positions (positions where current tick is outside the position's bounds) are automatically filtered out. Includes current token amounts (token0Amount, token1Amount) and USD values for each position calculated using CoinGecko price data.",
                    inputs: {
                        query: {
                            hotkey: "string (optional miner hotkey to filter by)",
                            pool: "string (optional pool address to filter by)"
                        }
                    },
                    outputs: {
                        success: "boolean",
                        positions: "Record<string, (LiquidityPosition & { emission: number, token0Amount?: string, token1Amount?: string, usdValue?: { token0Value: number, token1Value: number, totalValue: number, token0Price: number, token1Price: number } })[]> (map of miner hotkey to their liquidity positions with emission, current token amounts, and USD values)",
                        cached: "boolean (true if the response is from cache)",
                        error: "string (description of error if success is false)"
                    }
                },
                {
                    path: "/positions/:minerHotkey",
                    method: "GET",
                    description: "Retrieves all active Uniswap v3 liquidity positions for a specific miner with a linked Ethereum address. Results are cached for 5 minutes. Inactive liquidity positions (positions where current tick is outside the position's bounds) are automatically filtered out. Includes current token amounts (token0Amount, token1Amount) and USD values for each position calculated using CoinGecko price data.",
                    inputs: {
                        params: {
                            minerHotkey: "string (miner hotkey to filter by)"
                        }
                    },
                    outputs: {
                        success: "boolean",
                        positions: "(LiquidityPosition & { emission: number, token0Amount?: string, token1Amount?: string, usdValue?: { token0Value: number, token1Value: number, totalValue: number, token0Price: number, token1Price: number } })[] (array of liquidity positions with emission, current token amounts, and USD values)",
                        cached: "boolean (true if the response is from cache)",
                        error: "string (description of error if success is false)"
                    }
                },
                {
                    path: "/weights",
                    method: "GET",
                    description: "Retrieves the final calculated weight for each miner, which should directly correspond to the votes cast and the liquidity provided. Inactive liquidity positions (positions where current tick is outside the position's bounds) are automatically excluded from weight calculations.",
                    inputs: "None",
                    outputs: {
                        success: "boolean",
                        weights: "Record<string, number> (map of miner hotkey to their final weight)",
                        cached: "boolean (true if the response is from cache)",
                        error: "string (description of error if success is false)"
                    }
                },
                {
                    path: "/ping",
                    method: "POST",
                    description: "Validates a validator hotkey signature and checks version compatibility. Used for health checks and version validation.",
                    inputs: {
                        body: {
                            signature: "string (Polkadot/Substrate signature of the message)",
                            message: "string (formatted as 'blockNumStr|versionStr')",
                            address: "string (validator hotkey address)"
                        },
                        message_format_details: {
                            blockNumStr: "string (recent Bittensor block number within past 10 blocks)",
                            versionStr: "string (client version in format 'major.minor.patch')"
                        }
                    },
                    outputs: {
                        success: "boolean",
                        message: "string (e.g., 'Ping successful')",
                        serverVersion: "string (current server version)",
                        clientVersion: "string (client version from request)",
                        versionCompatible: "boolean (true if versions are compatible)",
                        versionMessage: "string (version message if client is running a different branch)",
                        error: "string (description of error if success is false)"
                    },
                    version_compatibility: {
                        major_minor_match: "Major and minor versions must match exactly",
                        patch_behind_ok: "Client patch version can be behind server patch version",
                        update_required: "If major or minor versions don't match, client must update"
                    }
                },
                {
                    path: "/voteCooldown/:address",
                    method: "GET",
                    description: "Retrieves the current cooldown status for a specific address's voting ability. Provides detailed timing information including remaining time and exact unlock timestamp.",
                    inputs: {
                        params: {
                            address: "string (coldkey address)"
                        }
                    },
                    outputs: {
                        success: "boolean",
                        cooldownStatus: "object (contains cooldown information) or null if no cooldown active",
                        message: "string (e.g., 'No active cooldown' or 'Cooldown active for 1h 12m')",
                        error: "string (description of error if success is false)"
                    },
                    cooldown_status_details: {
                        active: "boolean indicating if cooldown is currently active",
                        remainingTime: "milliseconds until cooldown expires",
                        remainingMinutes: "total minutes remaining",
                        timeDisplay: "human-readable format (e.g., '1h 12m' or '45m')",
                        cooldownUntil: "ISO timestamp when cooldown expires",
                        changeCount: "number of vote changes made by this address",
                        nextCooldownDuration: "what the next cooldown duration would be (e.g., '72m', '2h 24m')"
                    }
                },
                {
                    path: "/voteHistory/:address",
                    method: "GET",
                    description: "Retrieves the complete vote change history and current active vote for a specific address. Tracks all vote modifications with detailed cooldown information for transparency and audit purposes.",
                    inputs: {
                        params: {
                            address: "string (coldkey address)"
                        }
                    },
                    outputs: {
                        success: "boolean",
                        voteHistory: "Array<object> (list of vote changes with timestamps and cooldown information)",
                        currentVote: "object | null (current active vote if exists)",
                        message: "string (e.g., 'Vote history retrieved')",
                        error: "string (description of error if success is false)"
                    },
                    vote_history_details: {
                        oldPools: "previous pool configuration before the change",
                        newPools: "new pool configuration after the change",
                        changeTimestamp: "when the vote change occurred",
                        cooldownUntil: "when the cooldown period expired/expires",
                        changeCount: "sequential change counter for tracking vote modifications"
                    },
                    current_vote_details: {
                        pools: "current pool configuration",
                        totalWeight: "total weight of current vote",
                        blockNumber: "block number when vote was submitted",
                        isActive: "always true for current vote"
                    }
                },

            ]
        };
    })
    .post(
        '/updateVotes',
        async ({ body, request }) => {
            const { signature, message, address } = body as { signature: string, message: string, address: string };
            console.log(`Received vote submission from address: ${address}`);

            // Basic input validation
            const [isValidInput, inputError] = validateBasicInput(
                signature,
                message,
                address,
                MAX_SIGNATURE_LENGTH,
                MAX_MESSAGE_LENGTH,
                MAX_ADDRESS_LENGTH,
            );
            if (!isValidInput) {
                console.error(`Invalid input for address ${address}:`, inputError);
                return { success: false, error: inputError };
            }

            // Rate limiting
            const clientIP = getClientIP(request);
            const [ipAllowed, ipError] = checkRateLimit(clientIP, ipRequestCounts, MAX_REQUESTS_PER_IP);
            if (!ipAllowed) {
                console.error(`Rate limit exceeded for IP ${clientIP}`);
                return { success: false, error: sanitizeError(ipError!, 'Too many requests') };
            }

            const [addressAllowed, addressError] = checkRateLimit(`vote_${address}`, addressRequestCounts, MAX_VOTE_UPDATES_PER_ADDRESS);
            if (!addressAllowed) {
                console.error(`Rate limit exceeded for address ${address}`);
                return { success: false, error: sanitizeError(addressError!, 'Too many requests') };
            }

            const verification = verifySignature(message, signature, address);
            if (!verification.success) {
                console.error(`Signature verification failed for address ${address}`);
                return { success: false, error: sanitizeError(verification.error!, 'Authentication failed') };
            }

            const parts = message.split('|');
            if (parts.length !== 2) {
                console.error(`Invalid message format from address ${address}`);
                return { success: false, error: 'Invalid message format' };
            }
            const [poolsStr, blockNumStr] = parts;

            const blockNumber = Number(blockNumStr);
            if (Number.isNaN(blockNumber)) {
                console.error(`Invalid block number from address ${address}`);
                return { success: false, error: 'Invalid block number' };
            }

            const poolEntries = poolsStr.split(';');
            if (poolEntries.length > MAX_POOLS_PER_REQUEST) {
                console.error(`Too many pools from address ${address}: ${poolEntries.length}`);
                return { success: false, error: 'Too many pools' };
            }

            const pools: { address: string, weight: number }[] = [];
            let totalWeight = 0;

            for (const entry of poolEntries) {
                const [poolAddress, weightStr] = entry.split(',');
                if (!poolAddress || !weightStr) {
                    console.error(`Invalid pool entry format from address ${address}`);
                    return { success: false, error: 'Invalid pool entry format' };
                }

                // Validate Ethereum address format
                if (!/^0x[a-fA-F0-9]{40}$/.test(poolAddress)) {
                    console.error(`Invalid pool address format from address ${address}: ${poolAddress}`);
                    return { success: false, error: 'Invalid pool address format' };
                }

                const weight = Number(weightStr);
                if (Number.isNaN(weight)) {
                    console.error(`Invalid weight value from address ${address}`);
                    return { success: false, error: 'Invalid weight value' };
                }
                if (weight <= 0) {
                    console.error(`Non-positive weight from address ${address}`);
                    return { success: false, error: 'Weight must be positive' };
                }

                totalWeight += weight;
                pools.push({ address: poolAddress.toLowerCase(), weight });
            }

            if (pools.length === 0) {
                console.error(`No valid pools specified by address ${address}`);
                return { success: false, error: 'No valid pools specified' };
            }

            // Normalize weights to sum to VOTE_WEIGHT_TOTAL
            const normalizedPools = pools.map(pool => ({
                ...pool,
                weight: Math.round((pool.weight / totalWeight) * VOTE_WEIGHT_TOTAL)
            }));

            // Verify the sum is exactly VOTE_WEIGHT_TOTAL
            const finalSum = normalizedPools.reduce((sum, pool) => sum + pool.weight, 0);
            if (finalSum !== VOTE_WEIGHT_TOTAL) {
                // Adjust the last pool to make the sum exact
                const diff = VOTE_WEIGHT_TOTAL - finalSum;
                normalizedPools[normalizedPools.length - 1].weight += diff;
            }

            // After normalizing pools but before saving to DB, validate they are Uniswap V3 pools
            const [areValidPools, poolValidationError] = await validateUniswapV3Pools(provider, normalizedPools);
            if (!areValidPools) {
                console.error(`Invalid Uniswap V3 pools from address ${address}:`, poolValidationError);
                return { success: false, error: sanitizeError(poolValidationError!, 'Invalid Uniswap V3 pools') };
            }

            // Fetch and store pool information for all pools
            const [poolInfoStored, poolInfoError] = await validateAndStorePoolInfo(db, provider, normalizedPools);
            if (!poolInfoStored) {
                console.error(`Failed to store pool info for address ${address}:`, poolInfoError);
                return { success: false, error: sanitizeError(poolInfoError!, 'Failed to store pool information') };
            }

            const [currentChainBlock, blockErr] = await fetchCurrentBittensorBlock();
            if (blockErr) {
                console.error(`Failed to fetch current block for address ${address}:`, blockErr);
                return { success: false, error: sanitizeError(blockErr, 'Failed to fetch current block') };
            }
            if (blockNumber > currentChainBlock) {
                console.error(`Invalid block number from address ${address}: ${blockNumber} > ${currentChainBlock}`);
                return { success: false, error: 'Invalid block number' };
            }
            if (blockNumber < currentChainBlock - BLOCK_WINDOW) {
                console.error(`Block number expired for address ${address}: ${blockNumber} < ${currentChainBlock - BLOCK_WINDOW}`);
                return { success: false, error: 'Block number expired' };
            }

            // Ensure voter holds alpha tokens
            const holderList: any[] = getHolders() || [];
            if (!holderList.some(h => h.address === address)) {
                console.error(`Address ${address} does not hold alpha tokens`);
                return { success: false, error: 'Address does not hold alpha tokens' };
            }

            // Get existing votes first to check for actual changes
            const existingVote = await db.get('SELECT pools FROM user_votes WHERE ss58Address = ?', address) as any;
            const oldPoolsJson = existingVote ? existingVote.pools : null;
            const newPoolsJson = JSON.stringify(normalizedPools);
            
            // Check if there's an actual change in votes
            const hasVoteChange = !oldPoolsJson || oldPoolsJson !== newPoolsJson;
            
            if (hasVoteChange) {
                // Check vote cooldown only if there's an actual change
                const [cooldownAllowed, cooldownError, cooldownDuration] = await checkVoteCooldown(db, address, newPoolsJson);
                if (!cooldownAllowed) {
                    console.error(`Vote cooldown active for address ${address}:`, cooldownError);
                    
                    // Get detailed cooldown status to show when they can vote again
                    const [cooldownStatus, statusError] = await checkVoteCooldownStatus(db, address);
                    if (cooldownStatus && cooldownStatus.active) {
                        const errorMessage = `Vote change blocked by cooldown. You can vote again in ${cooldownStatus.timeDisplay} (at ${cooldownStatus.cooldownUntil})`;
                        return { success: false, error: errorMessage };
                    }
                    
                    return { success: false, error: sanitizeError(cooldownError!, 'Vote change blocked by cooldown') };
                }
            }

            // Execute operations sequentially with proper error handling
            try {
                // Update the votes
                const [_, dbErr] = await upsertUserVotes(db, address, normalizedPools, signature, message, blockNumber, 1.0);
                if (dbErr) {
                    console.error(`Database error for address ${address}:`, dbErr);
                    return { success: false, error: sanitizeError(`DB error: ${dbErr}`, 'Database operation failed') };
                }

                // Record vote change for cooldown tracking only if there was an actual change
                if (hasVoteChange && oldPoolsJson) {
                    // Get the cooldown duration that was calculated during the check
                    const [cooldownAllowed, cooldownError, cooldownDuration] = await checkVoteCooldown(db, address, newPoolsJson);
                    if (cooldownDuration) {
                        const [recorded, recordError] = await recordVoteChange(db, address, oldPoolsJson, newPoolsJson, cooldownDuration);
                        if (!recorded) {
                            console.warn(`Failed to record vote change for address ${address}:`, recordError);
                            // Don't fail the entire operation if recording fails, just log it
                        }
                    }
                }
            } catch (error) {
                console.error(`Operation failed for address ${address}:`, error);
                return { success: false, error: sanitizeError(`Operation failed: ${error}`, 'Database operation failed') };
            }

            console.log(`Successfully updated votes for address ${address} with ${normalizedPools.length} pools`);
            return { success: true, message: 'Votes updated', pools: normalizedPools };
        },
    )
    .post(
        '/claimAddress',
        async ({ body, request }) => {
            const { signature, message, address } = body as { signature: string, message: string, address: string };

            // Basic input validation
            const [isValidInput, inputError] = validateBasicInput(
                signature,
                message,
                address,
                MAX_SIGNATURE_LENGTH,
                MAX_MESSAGE_LENGTH,
                MAX_ADDRESS_LENGTH,
            );
            if (!isValidInput) return { success: false, error: inputError };

            // Rate limiting
            const clientIP = getClientIP(request);
            const [ipAllowed, ipError] = checkRateLimit(clientIP, ipRequestCounts, MAX_REQUESTS_PER_IP);
            if (!ipAllowed) return { success: false, error: sanitizeError(ipError!, 'Too many requests') };

            const [addressAllowed, addressError] = checkRateLimit(`claim_${address}`, addressRequestCounts, MAX_REQUESTS_PER_ADDRESS);
            if (!addressAllowed) return { success: false, error: sanitizeError(addressError!, 'Too many requests') };

            // Verify the hotkey is valid
            const subnetHotkeys = getSubnetHotkeys();
            if (!subnetHotkeys.includes(address)) return { success: false, error: 'Invalid hotkey address' };

            const hotkey = address;
            const verification = verifySignature(message, signature, hotkey);
            if (!verification.success) return { success: false, error: sanitizeError(verification.error!, 'Authentication failed') };

            const outer = message.split('|');
            if (outer.length !== 5) return { success: false, error: 'Invalid message format' };
            const [ethSig, ethAddrPayload, hotkeyPayload, blockNumStr, ethSigner] = outer;
            if (ethAddrPayload.toLowerCase() !== ethSigner.toLowerCase()) return { success: false, error: 'Address mismatch' };
            if (hotkeyPayload.toLowerCase() !== hotkey.toLowerCase()) return { success: false, error: 'Address mismatch' };

            // Validate Ethereum address format
            if (!/^0x[a-fA-F0-9]{40}$/.test(ethSigner)) return { success: false, error: 'Invalid Ethereum address format' };

            const submittedBlockNumber = Number(blockNumStr);
            if (Number.isNaN(submittedBlockNumber)) return { success: false, error: 'Invalid block number' };

            const [currentChainBlock, blockErr] = await fetchCurrentBittensorBlock();
            if (blockErr) return { success: false, error: sanitizeError(blockErr, 'Failed to fetch current block') };

            if (submittedBlockNumber > currentChainBlock) return { success: false, error: 'Invalid block number' };
            if (submittedBlockNumber < currentChainBlock - BLOCK_WINDOW) return { success: false, error: 'Block number expired' };

            const ethMessage = `${ethAddrPayload}|${hotkeyPayload}|${blockNumStr}`;
            const ethVerification = verifyEthereumSignature(ethMessage, ethSig, ethSigner);
            if (!ethVerification.success) return { success: false, error: sanitizeError(ethVerification.error!, 'Authentication failed') };

            // Verify the hotkey is a valid miner in the subnet (reusing subnetHotkeys from earlier check)
            if (!subnetHotkeys.includes(hotkey)) return { success: false, error: 'Hotkey must be a registered miner in the subnet' };

            const ethSignerLower = ethSigner.toLowerCase();
            const [existing, fetchErr] = await getAddressMapping(db, hotkey, ethSignerLower);
            if (fetchErr) return { success: false, error: sanitizeError(`DB error: ${fetchErr}`, 'Database operation failed') };
            if (existing && existing.ss58Address === hotkey && existing.ethereumAddress === ethSignerLower) return { success: true, message: 'Mapping already exists' };

            const [inserted, mapErr] = await setAddressMapping(db, hotkey, ethSignerLower);
            if (mapErr) return { success: false, error: sanitizeError(`DB error: ${mapErr}`, 'Database operation failed') };

            return { success: true, message: existing ? 'Address mapping updated' : 'Address mapping created' };
        },
    )
    .get(
        '/userVotes/:address',
        async ({ params, request }) => {
            const { address } = params;
            if (!address) return { success: false, error: 'Address required' };
            if (address.length > MAX_ADDRESS_LENGTH) return { success: false, error: 'Invalid address' };

            // Rate limiting for queries
            const clientIP = getClientIP(request);
            const [ipAllowed, ipError] = checkRateLimit(clientIP, ipRequestCounts, MAX_REQUESTS_PER_IP);
            if (!ipAllowed) return { success: false, error: sanitizeError(ipError!, 'Too many requests') };

            const [userVotes, err] = await getUserVotes(db, address);
            if (err) return { success: false, error: sanitizeError(`DB error: ${err}`, 'Database operation failed') };
            if (!userVotes) return { success: true, userVotes: null, message: 'No votes found' };

            return { success: true, userVotes };
        }
    )
    .get(
        '/allVotes',
        async ({ request }) => {
            const clientIP = getClientIP(request);
            const [ipAllowed, ipErr] = checkRateLimit(clientIP, ipRequestCounts, MAX_REQUESTS_PER_IP);
            if (!ipAllowed) return { success: false, error: sanitizeError(ipErr!, 'Too many requests') };

            if (votesCache.data && Date.now() - votesCache.lastUpdated < VOTES_CACHE_TTL_MS) {
                return { 
                    success: true, 
                    votes: votesCache.data.votes, 
                    totalAlphaTokens: votesCache.data.totalAlphaTokens,
                    cached: true 
                };
            }

            try {
                const rows = await db.all('SELECT ss58Address, pools, total_weight, block_number FROM user_votes');
                const votes = rows.map((r: any) => ({ ...r, pools: JSON.parse(r.pools) }));
                
                // Get current holders data
                const holders = getHolders() || [];
                interface Holder {
                    address: string;
                    alphaBalanceRaw: string;
                    taoBalanceRaw: string;
                    subnetRank: number | null;
                }
                const holderMap = new Map<string, number>(holders.map((h: Holder) => [h.address, parseFloat(h.alphaBalanceRaw || '0')]));
                
                // Filter out voters who don't hold any alpha tokens
                const validVotes = votes.filter(vote => {
                    const balance = holderMap.get(vote.ss58Address) || 0;
                    return balance > 0;
                });
                
                if (validVotes.length === 0) {
                    votesCache = { 
                        data: { votes: [], totalAlphaTokens: 0 }, 
                        lastUpdated: Date.now() 
                    };
                    return { 
                        success: true, 
                        votes: [],
                        totalAlphaTokens: 0,
                        cached: false 
                    };
                }
                
                // Calculate total alpha tokens held by valid voters
                const totalAlphaTokens = validVotes.reduce((sum: number, vote) => {
                    const balance = holderMap.get(vote.ss58Address) || 0;
                    return sum + balance;
                }, 0);

                // If only one valid voter, they get full weight
                if (validVotes.length === 1) {
                    const vote = validVotes[0];
                    const balance = holderMap.get(vote.ss58Address) || 0;
                    const weightedVotes = [{
                        ...vote,
                        alphaBalance: balance,
                        weightMultiplier: 1
                    }];
                    votesCache = { 
                        data: {
                            votes: weightedVotes,
                            totalAlphaTokens: balance
                        }, 
                        lastUpdated: Date.now() 
                    };
                    return { 
                        success: true, 
                        votes: weightedVotes,
                        totalAlphaTokens: balance,
                        cached: false 
                    };
                }

                // Calculate weight multipliers based on token holdings for valid voters
                const weightedVotes = validVotes.map(vote => {
                    const balance: number = holderMap.get(vote.ss58Address) || 0;
                    const weightMultiplier: number = totalAlphaTokens > 0 ? balance / totalAlphaTokens : 0;
                    return {
                        ...vote,
                        alphaBalance: balance,
                        weightMultiplier
                    };
                });

                votesCache = { 
                    data: {
                        votes: weightedVotes,
                        totalAlphaTokens
                    }, 
                    lastUpdated: Date.now() 
                };
                
                return { 
                    success: true, 
                    votes: weightedVotes,
                    totalAlphaTokens,
                    cached: false 
                };
            } catch (e: any) { return { success: false, error: sanitizeError(`DB error: ${e}`, 'Database operation failed') } }
        }
    )
    .get(
        '/allHolders',
        async ({ request }) => {
            const clientIP = getClientIP(request);
            const [ipAllowed, ipErr] = checkRateLimit(clientIP, ipRequestCounts, MAX_REQUESTS_PER_IP);
            if (!ipAllowed) return { success: false, error: sanitizeError(ipErr!, 'Too many requests') };

            return { success: true, holders: getHolders(), cached: true };
        },
    )
    .get(
        '/allAddresses',
        async ({ request }) => {
            const clientIP = getClientIP(request);
            const [ipAllowed, ipErr] = checkRateLimit(clientIP, ipRequestCounts, MAX_REQUESTS_PER_IP);
            if (!ipAllowed) return { success: false, error: sanitizeError(ipErr!, 'Too many requests') };

            const hotkeys = getSubnetHotkeys();
            try {
                const rows = await db.all('SELECT ss58Address, ethereumAddress FROM address_map');
                const addresses = rows.filter((r: any) => hotkeys.includes(r.ss58Address)).map((r: any) => ({ ss58Address: r.ss58Address, ethereumAddress: r.ethereumAddress }));
                return { success: true, addresses };
            } catch (e: any) {
                return { success: false, error: sanitizeError(`DB error: ${e}`, 'Database operation failed') };
            }
        }
    )
    .get(
        '/allMiners',
        async ({ request }) => {
            const clientIP = getClientIP(request);
            const [ipAllowed, ipErr] = checkRateLimit(clientIP, ipRequestCounts, MAX_REQUESTS_PER_IP);
            if (!ipAllowed) return { success: false, error: sanitizeError(ipErr!, 'Too many requests') };

            const hotkeys = getSubnetHotkeys();
            try {
                const rows = await db.all('SELECT ss58Address, ethereumAddress FROM address_map');
                const addressMap = new Map<string, string>(rows.map((r: any) => [r.ss58Address, r.ethereumAddress]));
                
                const miners = hotkeys.map(hotkey => ({
                    hotkeyAddress: hotkey,
                    ethereumAddress: addressMap.get(hotkey) || null
                }));
                
                const linkedMiners = miners.filter(miner => miner.ethereumAddress !== null).length;
                
                return { 
                    success: true, 
                    miners,
                    totalMiners: miners.length,
                    linkedMiners
                };
            } catch (e: any) {
                return { success: false, error: sanitizeError(`DB error: ${e}`, 'Database operation failed') };
            }
        }
    )
    .get(
        '/pools',
        async ({ request }) => {
            const clientIP = getClientIP(request);
            const [ipAllowed, ipErr] = checkRateLimit(clientIP, ipRequestCounts, MAX_REQUESTS_PER_IP);
            if (!ipAllowed) return { success: false, error: sanitizeError(ipErr!, 'Too many requests') };

            try {
                const rows = await db.all('SELECT ss58Address, pools, total_weight, block_number FROM user_votes');
                const votes = rows.map((r: any) => ({ ...r, pools: JSON.parse(r.pools) }));
                
                // Get current holders data
                const holders = getHolders() || [];
                interface Holder {
                    address: string;
                    alphaBalanceRaw: string;
                    taoBalanceRaw: string;
                    subnetRank: number | null;
                }
                const holderMap = new Map<string, number>(holders.map((h: Holder) => [h.address, parseFloat(h.alphaBalanceRaw || '0')]));
                
                // Filter out voters who don't hold any alpha tokens
                const validVotes = votes.filter(vote => {
                    const balance = holderMap.get(vote.ss58Address) || 0;
                    return balance > 0;
                });
                
                // Calculate total alpha tokens held by valid voters
                const totalAlphaTokens = validVotes.reduce((sum: number, vote) => {
                    const balance = holderMap.get(vote.ss58Address) || 0;
                    return sum + balance;
                }, 0);

                // Calculate weight multipliers based on token holdings for valid voters
                const weightedVotes = validVotes.map(vote => {
                    const balance: number = holderMap.get(vote.ss58Address) || 0;
                    const weightMultiplier: number = totalAlphaTokens > 0 ? balance / totalAlphaTokens : 0;
                    return {
                        ...vote,
                        alphaBalance: balance,
                        weightMultiplier
                    };
                });

                // Aggregate pools from all votes
                const poolMap = new Map<string, { address: string, totalWeight: number, voters: any[] }>();
                
                weightedVotes.forEach(vote => {
                    vote.pools.forEach((pool: any) => {
                        const poolAddress = pool.address.toLowerCase();
                        if (!poolMap.has(poolAddress)) {
                            poolMap.set(poolAddress, {
                                address: poolAddress,
                                totalWeight: 0,
                                voters: []
                            });
                        }
                        
                        const poolData = poolMap.get(poolAddress)!;
                        // Calculate weighted contribution: pool.weight * voter.weightMultiplier
                        const weightedContribution = pool.weight * vote.weightMultiplier;
                        poolData.totalWeight += weightedContribution;
                        poolData.voters.push({
                            address: vote.ss58Address,
                            weight: weightedContribution, // Use weighted contribution instead of raw weight
                            rawWeight: pool.weight, // Keep raw weight for reference
                            alphaBalance: vote.alphaBalance,
                            weightMultiplier: vote.weightMultiplier
                        });
                    });
                });

                // Filter out pools that don't have any active voters (voters with alpha tokens)
                const activePools = Array.from(poolMap.values()).filter(poolData => 
                    poolData.voters.some(voter => voter.alphaBalance > 0)
                );

                // Fetch detailed pool information for each active pool
                const poolsWithDetails = await Promise.all(
                    activePools.map(async (poolData) => {
                        const [poolInfo, poolInfoErr] = await getOrFetchPoolInfo(db, provider, poolData.address);
                        
                        return {
                            ...poolData,
                            token0: poolInfo?.token0 || null,
                            token1: poolInfo?.token1 || null,
                            token0Symbol: poolInfo?.token0Symbol || null,
                            token1Symbol: poolInfo?.token1Symbol || null,
                            fee: poolInfo?.fee || null,
                            poolInfoError: poolInfoErr || null
                        };
                    })
                );

                const pools = poolsWithDetails;
                
                return { 
                    success: true, 
                    pools,
                    totalPools: pools.length,
                    totalVoters: validVotes.length,
                    totalAlphaTokens,
                    cached: false 
                };
            } catch (e: any) { return { success: false, error: sanitizeError(`DB error: ${e}`, 'Database operation failed') } }
        }
    )
    .get('/positions', async ({ query, request }) => {
        const { hotkey, pool } = query;
        const clientIP = getClientIP(request);
        const [ipAllowed, ipErr] = checkRateLimit(clientIP, ipRequestCounts, MAX_REQUESTS_PER_IP);
        if (!ipAllowed) return { success: false, error: sanitizeError(ipErr!, 'Too many requests') };

        try {
            // We need all active positions to calculate normalized scores correctly, before any filtering.
            const [allActivePositions, fromCache] = await getMinerPositions(db);
            
            const poolEmissions = await calculatePoolEmissions();
            
            const [normalizedPositionScores, normPosErr] = await calculateAndNormalizePoolScores(allActivePositions);
            if (normPosErr) throw new Error(`Error calculating position scores: ${normPosErr}`);

            let positionsToProcess = allActivePositions;

            // Filter by hotkey if provided
            if (hotkey) {
                if (positionsToProcess[hotkey]) {
                    positionsToProcess = { [hotkey]: positionsToProcess[hotkey] };
                } else {
                    // If hotkey doesn't exist or has no active positions, return an empty object.
                    return { success: true, positions: {}, cached: fromCache };
                }
            }

            // Filter by pool address if provided
            if (pool) {
                const poolAddressLower = pool.toLowerCase();
                const filteredByPool: Record<string, LiquidityPosition[]> = {};
                for (const minerId in positionsToProcess) {
                    const positionsInPool = positionsToProcess[minerId].filter(p => p.pool.id.toLowerCase() === poolAddressLower);
                    if (positionsInPool.length > 0) {
                        filteredByPool[minerId] = positionsInPool;
                    }
                }
                positionsToProcess = filteredByPool;
            }

            const positionsWithEmissions: Record<string, (LiquidityPosition & { emission: number })[]> = {};

            for (const miner of Object.keys(positionsToProcess)) {
                positionsWithEmissions[miner] = [];
                for (const position of positionsToProcess[miner]) {
                    const poolAddress = position.pool.id.toLowerCase();
                    const poolEmission = poolEmissions.get(poolAddress) || 0;
                    const positionScoreInPool = normalizedPositionScores[position.id] ?? 0;

                    const emission = poolEmission * positionScoreInPool;
                    positionsWithEmissions[miner].push({ ...position, emission });
                }
            }
            
            return { success: true, positions: positionsWithEmissions, cached: fromCache };
        } catch (e: any) {
            return { success: false, error: sanitizeError(`Failed to get positions: ${e}`, 'Operation failed') };
        }
    })
    .get('/positions/:minerHotkey', async ({ params, request }) => {
        const { minerHotkey } = params;
        if (!minerHotkey) return { success: false, error: 'minerHotkey required' };
        if (minerHotkey.length > MAX_ADDRESS_LENGTH) return { success: false, error: 'Invalid minerHotkey' };

        const clientIP = getClientIP(request);
        const [ipAllowed, ipErr] = checkRateLimit(clientIP, ipRequestCounts, MAX_REQUESTS_PER_IP);
        if (!ipAllowed) return { success: false, error: sanitizeError(ipErr!, 'Too many requests') };

        try {
            const [positionsByMiner, fromCache] = await getMinerPositions(db);
            const positions = positionsByMiner[minerHotkey] || [];

            if (positions.length === 0) {
                return { success: true, positions: [], cached: fromCache };
            }

            const poolEmissions = await calculatePoolEmissions();

            const [normalizedPositionScores, normPosErr] = await calculateAndNormalizePoolScores(positionsByMiner);
            if (normPosErr) throw new Error(`Error calculating position scores: ${normPosErr}`);

            const positionsWithEmissions: (LiquidityPosition & { emission: number })[] = [];

            for (const position of positions) {
                const poolAddress = position.pool.id.toLowerCase();
                const poolEmission = poolEmissions.get(poolAddress) || 0;
                const positionScoreInPool = normalizedPositionScores[position.id] ?? 0;

                const emission = poolEmission * positionScoreInPool;
                positionsWithEmissions.push({ ...position, emission });
            }

            return { success: true, positions: positionsWithEmissions, cached: fromCache };
        } catch (e: any) {
            return { success: false, error: sanitizeError(`Failed to get positions: ${e}`, 'Operation failed') };
        }
    })
    .get('/weights', async ({ request }) => {
        const clientIP = getClientIP(request);
        const [ipAllowed, ipErr] = checkRateLimit(clientIP, ipRequestCounts, MAX_REQUESTS_PER_IP);
        if (!ipAllowed) return { success: false, error: sanitizeError(ipErr!, 'Too many requests') };
    
        try {
            const [positionsByMiner, fromCache] = await getMinerPositions(db);
            const poolEmissions = await calculatePoolEmissions();
    
            const [normalizedPositionScores, normPosErr] = await calculateAndNormalizePoolScores(positionsByMiner);
            if (normPosErr) throw new Error(`Error calculating position scores: ${normPosErr}`);
    
            const poolWeights: Record<string, number> = {};
            poolEmissions.forEach((value, key) => {
                poolWeights[key] = value;
            });
    
            const [finalMinerWeights, weightsErr] = await calculateFinalMinerWeights(positionsByMiner, normalizedPositionScores, poolWeights);
            if (weightsErr) throw new Error(`Error calculating final miner weights: ${weightsErr}`);
    
            return { success: true, weights: finalMinerWeights, cached: fromCache };
        } catch (e: any) {
            return { success: false, error: sanitizeError(`Failed to get weights: ${e}`, 'Operation failed') };
        }
    })
    .post('/ping', async ({ body, request }) => {
        const { signature, message, address } = body as { signature: string, message: string, address: string };
        console.log(`Received ping from validator: ${address}`);

        // Basic input validation
        const [isValidInput, inputError] = validateBasicInput(
            signature,
            message,
            address,
            MAX_SIGNATURE_LENGTH,
            MAX_MESSAGE_LENGTH,
            MAX_ADDRESS_LENGTH,
        );
        if (!isValidInput) {
            console.error(`Invalid input for validator ${address}:`, inputError);
            return { success: false, error: inputError };
        }

        // Rate limiting
        const clientIP = getClientIP(request);
        const [ipAllowed, ipError] = checkRateLimit(clientIP, ipRequestCounts, MAX_REQUESTS_PER_IP);
        if (!ipAllowed) {
            console.error(`Rate limit exceeded for IP ${clientIP}`);
            return { success: false, error: sanitizeError(ipError!, 'Too many requests') };
        }

        const [addressAllowed, addressError] = checkRateLimit(`ping_${address}`, addressRequestCounts, MAX_REQUESTS_PER_ADDRESS);
        if (!addressAllowed) {
            console.error(`Rate limit exceeded for validator ${address}`);
            return { success: false, error: sanitizeError(addressError!, 'Too many requests') };
        }

        // Verify the hotkey is a valid validator in the subnet
        const subnetHotkeys = getSubnetHotkeys();
        if (!subnetHotkeys.includes(address)) {
            console.error(`Invalid validator hotkey: ${address}`);
            return { success: false, error: 'Invalid validator hotkey' };
        }

        const verification = verifySignature(message, signature, address);
        if (!verification.success) {
            console.error(`Signature verification failed for validator ${address}`);
            return { success: false, error: sanitizeError(verification.error!, 'Authentication failed') };
        }

        const parts = message.split('|');
        if (parts.length !== 2) {
            console.error(`Invalid message format from validator ${address}`);
            return { success: false, error: 'Invalid message format' };
        }
        const [blockNumStr, versionStr] = parts;

        const blockNumber = Number(blockNumStr);
        if (Number.isNaN(blockNumber)) {
            console.error(`Invalid block number from validator ${address}`);
            return { success: false, error: 'Invalid block number' };
        }

        // Validate version format
        if (!/^\d+\.\d+\.\d+$/.test(versionStr)) {
            console.error(`Invalid version format from validator ${address}: ${versionStr}`);
            return { success: false, error: 'Invalid version format' };
        }

        // Check block number is recent (within past 10 blocks but not past current)
        const [currentChainBlock, blockErr] = await fetchCurrentBittensorBlock();
        if (blockErr) {
            console.error(`Failed to fetch current block for validator ${address}:`, blockErr);
            return { success: false, error: sanitizeError(blockErr, 'Failed to fetch current block') };
        }

        if (blockNumber > currentChainBlock) {
            console.error(`Invalid block number from validator ${address}: ${blockNumber} > ${currentChainBlock}`);
            return { success: false, error: 'Invalid block number' };
        }
        if (blockNumber < currentChainBlock - 10) {
            console.error(`Block number too old from validator ${address}: ${blockNumber} < ${currentChainBlock - 10}`);
            return { success: false, error: 'Block number too old' };
        }

        // Check version compatibility
        const [versionCompatible, versionMessage] = isVersionCompatible(versionStr, VERSION);
        if (!versionCompatible) {
            console.error(`Version incompatible from validator ${address}: client=${versionStr}, server=${VERSION}`);
            return { 
                success: false, 
                error: 'Version incompatible - update required',
                serverVersion: VERSION,
                clientVersion: versionStr,
                versionCompatible: false,
                versionMessage
            };
        }

        console.log(`Ping successful from validator ${address} with version ${versionStr}${versionMessage ? ` - ${versionMessage}` : ''}`);
        return { 
            success: true, 
            message: 'Ping successful',
            serverVersion: VERSION,
            clientVersion: versionStr,
            versionCompatible: true,
            versionMessage
        };
    })
    .get(
        '/voteCooldown/:address',
        async ({ params, request }) => {
            const { address } = params;
            if (!address) return { success: false, error: 'Address required' };
            if (address.length > MAX_ADDRESS_LENGTH) return { success: false, error: 'Invalid address' };

            // Rate limiting for queries
            const clientIP = getClientIP(request);
            const [ipAllowed, ipError] = checkRateLimit(clientIP, ipRequestCounts, MAX_REQUESTS_PER_IP);
            if (!ipAllowed) return { success: false, error: sanitizeError(ipError!, 'Too many requests') };

            const [cooldownStatus, cooldownErr] = await checkVoteCooldownStatus(db, address);
            if (cooldownErr) return { success: false, error: sanitizeError(`DB error: ${cooldownErr}`, 'Database operation failed') };

            if (cooldownStatus.active) {
                return { 
                    success: true, 
                    cooldownStatus, 
                    message: `Cooldown active for ${cooldownStatus.timeDisplay}` 
                };
            }

            return { 
                success: true, 
                cooldownStatus, 
                message: 'No active cooldown' 
            };
        }
    )
            .get(
            '/voteHistory/:address',
            async ({ params, request }) => {
                const { address } = params;
                if (!address) return { success: false, error: 'Address required' };
                if (address.length > MAX_ADDRESS_LENGTH) return { success: false, error: 'Invalid address' };

                // Rate limiting for queries
                const clientIP = getClientIP(request);
                const [ipAllowed, ipError] = checkRateLimit(clientIP, ipRequestCounts, MAX_REQUESTS_PER_IP);
                if (!ipAllowed) return { success: false, error: sanitizeError(ipError!, 'Too many requests') };

                try {
                    // Get current active vote
                    const currentVote = await db.get('SELECT ss58Address, pools, total_weight, block_number FROM user_votes WHERE ss58Address = ?', address);
                    
                    // Get vote change history
                    const rows = await db.all('SELECT ss58Address, old_pools, new_pools, change_timestamp, cooldown_until, change_count FROM vote_change_history WHERE ss58Address = ? ORDER BY change_timestamp DESC', address);
                    
                    const voteHistory = rows.map(row => {
                        try {
                            return {
                                oldPools: row.old_pools ? JSON.parse(row.old_pools) : null,
                                newPools: row.new_pools ? JSON.parse(row.new_pools) : null,
                                changeTimestamp: row.change_timestamp,
                                cooldownUntil: row.cooldown_until,
                                changeCount: row.change_count
                            };
                        } catch (parseError) {
                            console.error(`Failed to parse JSON for row in vote history for address ${address}:`, parseError);
                            // Return a safe fallback for malformed data
                            return {
                                oldPools: null,
                                newPools: null,
                                changeTimestamp: row.change_timestamp,
                                cooldownUntil: row.cooldown_until,
                                changeCount: row.change_count,
                                parseError: 'Data corrupted'
                            };
                        }
                    });

                    // Include current active vote if it exists
                    const currentVoteData = currentVote ? {
                        currentVote: {
                            pools: JSON.parse(currentVote.pools),
                            totalWeight: currentVote.total_weight,
                            blockNumber: currentVote.block_number,
                            isActive: true
                        }
                    } : {};

                    return { 
                        success: true, 
                        voteHistory, 
                        ...currentVoteData,
                        message: 'Vote history retrieved' 
                    };
                } catch (e: any) {
                    return { success: false, error: sanitizeError(`DB error: ${e}`, 'Database operation failed') };
                }
            }
        )


// Initialize the server with cold-loaded data
const startServer = async (): Promise<void> => {
    console.log('Starting server initialization...');
    
    // Cold load holders data before starting the server
    const [initialized, initError] = await initializeHoldersCache();
    if (!initialized) {
        console.error('Failed to initialize holders cache:', initError);
        console.error('Server startup aborted. Please check your TAOSTATS_API_KEY and network connection.');
        process.exit(1);
    }
    
    // Cold load subnet hotkeys data
    const [hkInit, hkErr] = await initializeSubnetHotkeysCache();
    if (!hkInit) console.error('Failed to initialize subnet hotkeys cache:', hkErr);
    
    // Handle backward compatibility: fetch missing pool information
    console.log('Checking for missing pool information...');
    try {
        const rows = await db.all('SELECT ss58Address, pools FROM user_votes');
        const allPools = new Set<string>();
        
        // Collect all unique pool addresses from existing votes
        rows.forEach((row: any) => {
            const pools = JSON.parse(row.pools);
            pools.forEach((pool: any) => {
                allPools.add(pool.address.toLowerCase());
            });
        });
        
        // Check which pools don't have detailed information stored
        const [storedPoolAddresses, storedErr] = await getAllPoolAddresses(db);
        if (storedErr) {
            console.error('Failed to get stored pool addresses:', storedErr);
        } else {
            const missingPools = Array.from(allPools).filter(addr => !storedPoolAddresses.includes(addr));
            
            if (missingPools.length > 0) {
                console.log(`Found ${missingPools.length} pools with missing information. Fetching...`);
                
                // Fetch missing pool information in batches to avoid overwhelming the RPC
                const batchSize = 5;
                for (let i = 0; i < missingPools.length; i += batchSize) {
                    const batch = missingPools.slice(i, i + batchSize);
                    console.log(`Processing batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(missingPools.length / batchSize)}`);
                    
                    await Promise.all(batch.map(async (poolAddress) => {
                        const [poolInfo, poolErr] = await getOrFetchPoolInfo(db, provider, poolAddress);
                        if (poolErr) {
                            console.warn(`Failed to fetch info for pool ${poolAddress}:`, poolErr);
                        } else {
                            console.log(`✓ Fetched info for pool ${poolAddress}`);
                        }
                    }));
                    
                    // Small delay between batches to be respectful to the RPC
                    if (i + batchSize < missingPools.length) {
                        await new Promise(resolve => setTimeout(resolve, 1000));
                    }
                }
                
                console.log('Pool information update complete.');
            } else {
                console.log('All pools have detailed information stored.');
            }
        }
    } catch (error) {
        console.error('Error during pool information update:', error);
    }
    
    // Start periodic refresh
    startPeriodicHoldersRefresh();
    startPeriodicSubnetHotkeysRefresh();
    
    // Start the web server
    app.listen(3000);
    
    console.log(`Server running at http://${app.server?.hostname}:${app.server?.port}`);
};

// Cleanup handlers
process.on('SIGINT', async () => {
    console.log('Shutting down server...');
    await closeBittensorConnection();
    stopPeriodicSubnetHotkeysRefresh();
    stopPeriodicHoldersRefresh();
    process.exit(0);
});

process.on('SIGTERM', async () => {
    console.log('Shutting down server...');
    await closeBittensorConnection();
    stopPeriodicSubnetHotkeysRefresh();
    stopPeriodicHoldersRefresh();
    process.exit(0);
});

export { startServer }; // Export startServer
export type App = typeof app;

// If this script is executed directly (e.g., by fork), start the server.
if (import.meta.main) {
    startServer().catch((error) => {
        console.error('❌ Failed to start server from server.ts direct execution:', error);
        process.exit(1); // Exit with error if server fails to start
    });
}

async function calculateAndNormalizePoolScores(
    minerLiquidityPositions: Record<string, LiquidityPosition[]>
): Promise<[Record<string, number>, Error | null]> { 
    const poolRawScores: Record<string, Array<{ minerId: string; positionId: string; rawScore: number }>> = {};

    try {
        for (const [minerId, positions] of Object.entries(minerLiquidityPositions)) {
            for (const pos of positions) {
                const poolId = pos.pool?.id;
                const currentTickStr = pos.pool?.tick;

                if (!poolId || typeof poolId !== 'string' || typeof currentTickStr === 'undefined' || currentTickStr === null) {
                    continue;
                }
                const currentTick = Number(currentTickStr);
                if (isNaN(currentTick)) {
                    continue;
                }

                const scoreResult = calculatePositionScore(pos, currentTick);
                const rawScore = scoreResult.finalScore;
                const positionId = pos.id;

                if (!poolRawScores[poolId]) {
                    poolRawScores[poolId] = [];
                }
                poolRawScores[poolId].push({ minerId, positionId, rawScore });
            }
        }

        const normalizedPositionScores: Record<string, number> = {};

        for (const poolId in poolRawScores) {
            const positionsInPool = poolRawScores[poolId];
            const totalRawScoreInPool = positionsInPool.reduce((sum, p) => sum + p.rawScore, 0);

            if (totalRawScoreInPool > 0) {
                for (const p of positionsInPool) {
                    normalizedPositionScores[p.positionId] = p.rawScore / totalRawScoreInPool;
                }
            } else {
                for (const p of positionsInPool) {
                    normalizedPositionScores[p.positionId] = 0;
                }
            }
        }
        return [normalizedPositionScores, null];
    } catch (err) {
        const error = err instanceof Error ? err : new Error("Failed to calculate/normalize pool scores");
        return [{}, error];
    }
}

async function calculateFinalMinerWeights(
    minerLiquidityPositions: Record<string, LiquidityPosition[]>,
    normalizedPositionScores: Record<string, number>,
    poolWeights: Record<string, number>
): Promise<[Record<string, number>, Error | null]> {
    const finalMinerWeights: Record<string, number> = {};

    try {
        for (const minerId of Object.keys(minerLiquidityPositions)) {
            finalMinerWeights[minerId] = 0;
        }

        for (const [minerId, positions] of Object.entries(minerLiquidityPositions)) {
            let minerTotalContribution = 0;
            for (const pos of positions) {
                const positionId = pos.id;
                const poolId = pos.pool?.id;

                if (!poolId || typeof poolId !== 'string') continue;

                const normalizedScore = normalizedPositionScores[positionId] ?? 0;
                const voteWeight = poolWeights[poolId.toLowerCase()] || 0;
                
                const contribution = normalizedScore * voteWeight;
                minerTotalContribution += contribution;
            }
            finalMinerWeights[minerId] = minerTotalContribution;
        }
        
        const threshold = 1e-9;
        let totalWeight = 0;
        for (const minerId in finalMinerWeights) {
            if (finalMinerWeights[minerId] < threshold) {
                finalMinerWeights[minerId] = 0;
            }
            totalWeight += finalMinerWeights[minerId];
        }
        
        if (totalWeight > 0) {
            for (const minerId in finalMinerWeights) {
                finalMinerWeights[minerId] = finalMinerWeights[minerId] / totalWeight;
            }
        }

        return [finalMinerWeights, null];
    } catch (err) {
        const error = err instanceof Error ? err : new Error("Failed to calculate final miner weights");
        return [{}, error];
    }
}

// Global version loaded from VERSION file
const VERSION = readFileSync('VERSION', 'utf8').trim();

// Version comparison utility
function isVersionCompatible(clientVersion: string, serverVersion: string): [boolean, string | null] {
    const parseVersion = (version: string): [number, number, number] => {
        const parts = version.split('.').map(Number);
        if (parts.length !== 3 || parts.some(isNaN)) {
            throw new Error('Invalid version format');
        }
        return [parts[0], parts[1], parts[2]];
    };

    try {
        const [clientMajor, clientMinor, clientPatch] = parseVersion(clientVersion);
        const [serverMajor, serverMinor, serverPatch] = parseVersion(serverVersion);

        // Major and minor versions must match exactly
        if (clientMajor !== serverMajor || clientMinor !== serverMinor) {
            return [false, null];
        }

        // If client patch is higher than server patch, they're running a different branch
        if (clientPatch > serverPatch) {
            return [true, 'Client detected to be running a branch different from the master branch'];
        }

        // Patch version can be behind (client can be older)
        return [clientPatch <= serverPatch, null];
    } catch (error) {
        return [false, null];
    }
}