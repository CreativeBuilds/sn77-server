import { ethers } from 'ethers';
import { Pool } from './poolUtils';

const UNISWAP_V3_FACTORY = '0x1F98431c8aD98523631AE4a59f267346ea31F984';
const UNISWAP_V3_FACTORY_ABI = [
  'function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address pool)',
  'event PoolCreated(address indexed token0, address indexed token1, uint24 indexed fee, int24 tickSpacing, address pool)'
];

const UNISWAP_V3_POOL_ABI = [
  'function token0() external view returns (address)',
  'function token1() external view returns (address)',
  'function slot0() external view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)',
  'function fee() external view returns (uint24)'
];

const ERC20_ABI = [
  'function symbol() external view returns (string)',
  'function name() external view returns (string)'
];

// Common token addresses
const COMMON_TOKENS = {
  WETH: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
  USDC: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  DAI: '0x6B175474E89094C44Da98b954EedeAC495271d0F',
  USDT: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
  WBTC: '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599'
};

// Common fee tiers
const FEE_TIERS = [500, 3000, 10000];

// Cache for token symbols
const tokenSymbolCache = new Map<string, string>();

async function getTokenSymbol(provider: ethers.Provider, address: string): Promise<string> {
  if (tokenSymbolCache.has(address)) return tokenSymbolCache.get(address)!;
  
  try {
    const tokenContract = new ethers.Contract(address, ERC20_ABI, provider);
    const symbol = await tokenContract.symbol();
    tokenSymbolCache.set(address, symbol);
    return symbol;
  } catch (error) {
    console.warn(`Failed to get symbol for token ${address}:`, error);
    return 'UNKNOWN';
  }
}

async function fetchPoolInfo(provider: ethers.Provider, poolAddress: string): Promise<[Pool | null, string | null]> {
  try {
    const poolContract = new ethers.Contract(poolAddress, UNISWAP_V3_POOL_ABI, provider);
    const [token0, token1] = await Promise.all([
      poolContract.token0(),
      poolContract.token1()
    ]);

    const [token0Symbol, token1Symbol] = await Promise.all([
      getTokenSymbol(provider, token0),
      getTokenSymbol(provider, token1)
    ]);

    return [{
      address: poolAddress,
      weight: 0,
      token0,
      token1,
      token0Symbol,
      token1Symbol
    }, null];
  } catch (error) {
    return [null, `Failed to get pool info: ${error}`];
  }
}

export const searchPools = async (query: string): Promise<[Pool[], string | null]> => {
  try {
    const provider = new ethers.JsonRpcProvider(process.env.ETH_RPC_URL || 'https://eth.llamarpc.com');
    const factory = new ethers.Contract(UNISWAP_V3_FACTORY, UNISWAP_V3_FACTORY_ABI, provider);
    
    const pools: Pool[] = [];
    const processedPools = new Set<string>();

    // If query is an address, try to get pool info directly
    if (ethers.isAddress(query)) {
      const [poolInfo, err] = await fetchPoolInfo(provider, query);
      if (!err && poolInfo) return [[poolInfo], null];
    }

    // Search through common token pairs
    const commonTokens = Object.entries(COMMON_TOKENS);
    for (let i = 0; i < commonTokens.length; i++) {
      for (let j = i + 1; j < commonTokens.length; j++) {
        const [token0Symbol, token0Address] = commonTokens[i];
        const [token1Symbol, token1Address] = commonTokens[j];

        // Check if query matches either token symbol
        if (!query.toLowerCase().includes(token0Symbol.toLowerCase()) && 
            !query.toLowerCase().includes(token1Symbol.toLowerCase())) continue;

        for (const fee of FEE_TIERS) {
          const poolAddress = await factory.getPool(token0Address, token1Address, fee);
          if (poolAddress === ethers.ZeroAddress || processedPools.has(poolAddress)) continue;

          const [poolInfo, err] = await fetchPoolInfo(provider, poolAddress);
          if (err || !poolInfo) continue;

          pools.push(poolInfo);
          processedPools.add(poolAddress);
        }
      }
    }

    return [pools, null];
  } catch (error) {
    return [[], `Failed to search pools: ${error}`];
  }
};

export const getPoolInfo = async (poolAddress: string): Promise<[Pool | null, string | null]> => {
  try {
    const provider = new ethers.JsonRpcProvider(process.env.ETH_RPC_URL || 'https://eth.llamarpc.com');
    return await fetchPoolInfo(provider, poolAddress);
  } catch (error) {
    return [null, `Failed to get pool info: ${error}`];
  }
}; 