import { ethers } from 'ethers';

// Uniswap V3 Factory address on Ethereum mainnet
const UNISWAP_V3_FACTORY = '0x1F98431c8aD98523631AE4a59f267346ea31F984';

// Uniswap V3 Factory ABI (minimal for pool validation)
const FACTORY_ABI = [
    'function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address pool)'
];

// Uniswap V3 Pool ABI (minimal for validation)
const POOL_ABI = [
    'function token0() external view returns (address)',
    'function token1() external view returns (address)',
    'function fee() external view returns (uint24)'
];

export const validateUniswapV3Pool = async (
    provider: ethers.Provider,
    poolAddress: string
): Promise<[boolean, string | null]> => {
    try {
        // Create contract instances
        const factory = new ethers.Contract(UNISWAP_V3_FACTORY, FACTORY_ABI, provider);
        const pool = new ethers.Contract(poolAddress, POOL_ABI, provider);

        // Get pool details
        const [token0, token1, fee] = await Promise.all([
            pool.token0(),
            pool.token1(),
            pool.fee()
        ]);

        // Verify pool exists in factory
        const factoryPool = await factory.getPool(token0, token1, fee);
        if (factoryPool.toLowerCase() !== poolAddress.toLowerCase()) {
            return [false, 'Pool not found in Uniswap V3 Factory'];
        }

        return [true, null];
    } catch (error) {
        return [false, `Failed to validate pool: ${error}`];
    }
};

export const validateUniswapV3Pools = async (
    provider: ethers.Provider,
    pools: { address: string; weight: number }[]
): Promise<[boolean, string | null]> => {
    try {
        const validationPromises = pools.map(pool => 
            validateUniswapV3Pool(provider, pool.address)
        );

        const results = await Promise.all(validationPromises);
        const invalidPools = results
            .map(([valid, error], index) => ({ valid, error, address: pools[index].address }))
            .filter(result => !result.valid);

        if (invalidPools.length > 0) {
            const errorMessage = invalidPools
                .map(pool => `${pool.address}: ${pool.error}`)
                .join(', ');
            return [false, `Invalid pools found: ${errorMessage}`];
        }

        return [true, null];
    } catch (error) {
        return [false, `Failed to validate pools: ${error}`];
    }
}; 