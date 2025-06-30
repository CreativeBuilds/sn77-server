import { ethers } from 'ethers';
import { Database } from 'sqlite';
import { getPoolInfo as getDbPoolInfo, setPoolInfo } from './dbUtils';

// Uniswap V3 Pool ABI for fetching detailed information
const POOL_ABI = [
    'function token0() external view returns (address)',
    'function token1() external view returns (address)',
    'function fee() external view returns (uint24)',
    'function liquidity() external view returns (uint128)',
];

// ERC20 ABI for token symbols
const ERC20_ABI = [
    'function symbol() external view returns (string)',
    'function name() external view returns (string)'
];

// Cache for token symbols to reduce RPC calls
const tokenSymbolCache = new Map<string, string>();

export interface PoolDetails {
    address: string;
    token0: string;
    token1: string;
    token0Symbol: string | null;
    token1Symbol: string | null;
    fee: number;
    liquidity: string | null;
}

export const getTokenSymbol = async (
    provider: ethers.Provider,
    address: string
): Promise<string | null> => {
    if (tokenSymbolCache.has(address)) return tokenSymbolCache.get(address)!;
    
    try {
        const tokenContract = new ethers.Contract(address, ERC20_ABI, provider);
        const symbol = await tokenContract.symbol();
        tokenSymbolCache.set(address, symbol);
        return symbol;
    } catch (error) {
        console.warn(`Failed to get symbol for token ${address}:`, error);
        return null;
    }
};

export const fetchPoolDetailsFromChain = async (
    provider: ethers.Provider,
    poolAddress: string
): Promise<[PoolDetails | null, string | null]> => {
    try {
        const poolContract = new ethers.Contract(poolAddress, POOL_ABI, provider);
        
        // Get basic pool information
        const [token0, token1, fee, liquidity] = await Promise.all([
            poolContract.token0(),
            poolContract.token1(),
            poolContract.fee(),
            poolContract.liquidity(),
        ]);

        // Get token symbols
        const [token0Symbol, token1Symbol] = await Promise.all([
            getTokenSymbol(provider, token0),
            getTokenSymbol(provider, token1)
        ]);

        return [{
            address: poolAddress.toLowerCase(),
            token0: token0.toLowerCase(),
            token1: token1.toLowerCase(),
            token0Symbol,
            token1Symbol,
            fee: Number(fee),
            liquidity: liquidity.toString(),
        }, null];
    } catch (error) {
        return [null, `Failed to fetch pool details: ${error}`];
    }
};

export const getOrFetchPoolInfo = async (
    db: Database,
    provider: ethers.Provider,
    poolAddress: string
): Promise<[PoolDetails | null, string | null]> => {
    try {
        // First try to get from database
        const [dbPoolInfo, dbErr] = await getDbPoolInfo(db, poolAddress);
        if (dbErr) return [null, `Database error: ${dbErr}`];
        
        if (dbPoolInfo && dbPoolInfo.liquidity) {
            return [{
                address: dbPoolInfo.address,
                token0: dbPoolInfo.token0,
                token1: dbPoolInfo.token1,
                token0Symbol: dbPoolInfo.token0Symbol,
                token1Symbol: dbPoolInfo.token1Symbol,
                fee: dbPoolInfo.fee,
                liquidity: dbPoolInfo.liquidity,
            }, null];
        }

        // If not in database, fetch from chain
        const [chainPoolInfo, chainErr] = await fetchPoolDetailsFromChain(provider, poolAddress);
        if (chainErr) return [null, chainErr];
        if (!chainPoolInfo) return [null, 'Failed to fetch pool details from chain'];

        // Store in database for future use
        const [_, storeErr] = await setPoolInfo(
            db,
            chainPoolInfo.address,
            chainPoolInfo.token0,
            chainPoolInfo.token1,
            chainPoolInfo.token0Symbol,
            chainPoolInfo.token1Symbol,
            chainPoolInfo.fee,
            chainPoolInfo.liquidity || '0'
        );
        
        if (storeErr) {
            console.warn(`Failed to store pool info for ${poolAddress}:`, storeErr);
            // Still return the fetched data even if storage fails
        }

        return [chainPoolInfo, null];
    } catch (error) {
        return [null, `Failed to get or fetch pool info: ${error}`];
    }
};

export const validateAndStorePoolInfo = async (
    db: Database,
    provider: ethers.Provider,
    pools: { address: string; weight: number }[]
): Promise<[boolean, string | null]> => {
    try {
        const poolInfoPromises = pools.map(pool => 
            getOrFetchPoolInfo(db, provider, pool.address)
        );

        const results = await Promise.all(poolInfoPromises);
        const failedPools = results
            .map(([info, error], index) => ({ info, error, address: pools[index].address }))
            .filter(result => !result.info);

        if (failedPools.length > 0) {
            const errorMessage = failedPools
                .map(pool => `${pool.address}: ${pool.error}`)
                .join(', ');
            return [false, `Failed to fetch pool info: ${errorMessage}`];
        }

        return [true, null];
    } catch (error) {
        return [false, `Failed to validate and store pool info: ${error}`];
    }
}; 