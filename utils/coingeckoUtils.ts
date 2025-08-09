// CoinGecko API utilities for fetching token prices dynamically
export type Result<T> = [T, Error | null];

interface CoinGeckoToken {
    id: string;
    symbol: string;
    name: string;
    platforms: Record<string, string>;
}

interface CoinGeckoPrice {
    usd: number;
    usd_24h_change: number;
    usd_market_cap: number;
}

interface TokenPrice {
    usd: number;
    symbol: string;
    name: string;
}

// Cache for token prices to reduce API calls
const priceCache = new Map<string, { price: TokenPrice; timestamp: number }>();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// Cache for token ID mappings (contract address -> CoinGecko ID)
const tokenIdCache = new Map<string, string>();
const TOKEN_ID_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Get CoinGecko token ID from contract address
 */
async function getTokenIdFromAddress(contractAddress: string): Promise<[string | null, Error | null]> {
    const cacheKey = contractAddress.toLowerCase();
    const cached = tokenIdCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < TOKEN_ID_CACHE_TTL_MS) {
        return [cached.tokenId, null];
    }

    try {
        const response = await fetch('https://api.coingecko.com/api/v3/coins/list?include_platform=true');
        if (!response.ok) {
            if (response.status === 429) {
                return [null, new Error('CoinGecko API rate limit exceeded. Please try again later.')];
            }
            return [null, new Error(`CoinGecko API error: ${response.status}`)];
        }
        
        const tokens: CoinGeckoToken[] = await response.json();
        
        // Find token by Ethereum contract address
        const token = tokens.find(t => 
            t.platforms.ethereum?.toLowerCase() === cacheKey
        );
        
        if (!token) return [null, null]; // Token not found, but not an error
        
        tokenIdCache.set(cacheKey, { tokenId: token.id, timestamp: Date.now() });
        return [token.id, null];
    } catch (error) {
        return [null, new Error(`Failed to fetch token list: ${error}`)];
    }
}

/**
 * Fetch USD price for a token by contract address
 */
export async function getTokenPrice(contractAddress: string): Promise<[TokenPrice | null, Error | null]> {
    const cacheKey = contractAddress.toLowerCase();
    const cached = priceCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
        return [cached.price, null];
    }

    const [tokenId, tokenIdErr] = await getTokenIdFromAddress(contractAddress);
    if (tokenIdErr) return [null, tokenIdErr];
    if (!tokenId) return [null, null]; // Token not found on CoinGecko

    try {
        const response = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${tokenId}&vs_currencies=usd&include_24hr_change=true&include_market_cap=true`);
        if (!response.ok) {
            if (response.status === 429) {
                return [null, new Error('CoinGecko API rate limit exceeded. Please try again later.')];
            }
            return [null, new Error(`CoinGecko API error: ${response.status}`)];
        }
        
        const data: Record<string, CoinGeckoPrice> = await response.json();
        const priceData = data[tokenId];
        
        if (!priceData) return [null, null];
        
        const tokenPrice: TokenPrice = {
            usd: priceData.usd,
            symbol: '', // Will be filled by caller if needed
            name: ''    // Will be filled by caller if needed
        };
        
        priceCache.set(cacheKey, { price: tokenPrice, timestamp: Date.now() });
        return [tokenPrice, null];
    } catch (error) {
        return [null, new Error(`Failed to fetch price for ${contractAddress}: ${error}`)];
    }
}

// Helper function to add delay between API calls
function delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Calculate USD value of deposited tokens in a liquidity position
 */
export async function calculatePositionUSDValue(
    depositedToken0: string,
    depositedToken1: string,
    token0Address: string,
    token1Address: string,
    token0Symbol: string,
    token1Symbol: string
): Promise<[{
    token0Value: number;
    token1Value: number;
    totalValue: number;
    token0Price: number;
    token1Price: number;
} | null, Error | null]> {
    const deposited0 = parseFloat(depositedToken0);
    const deposited1 = parseFloat(depositedToken1);
    
    if (isNaN(deposited0) || isNaN(deposited1)) {
        return [null, new Error('Invalid deposited token amounts')];
    }

    const [token0PriceData, token0Err] = await getTokenPrice(token0Address);
    if (token0Err) return [null, token0Err];
    
    const [token1PriceData, token1Err] = await getTokenPrice(token1Address);
    if (token1Err) return [null, token1Err];

    const token0Price = token0PriceData?.usd || 0;
    const token1Price = token1PriceData?.usd || 0;
    
    const token0Value = deposited0 * token0Price;
    const token1Value = deposited1 * token1Price;
    const totalValue = token0Value + token1Value;

    return [{
        token0Value,
        token1Value,
        totalValue,
        token0Price,
        token1Price
    }, null];
}

/**
 * Batch fetch prices for multiple tokens to reduce API calls
 */
export async function getBatchTokenPrices(contractAddresses: string[]): Promise<[Record<string, TokenPrice>, Error | null]> {
    const uniqueAddresses = [...new Set(contractAddresses.map(addr => addr.toLowerCase()))];
    const prices: Record<string, TokenPrice> = {};
    const addressesToFetch: string[] = [];

    // Check cache first
    for (const address of uniqueAddresses) {
        const cached = priceCache.get(address);
        if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
            prices[address] = cached.price;
        } else {
            addressesToFetch.push(address);
        }
    }

    // Fetch missing prices in batches
    const batchSize = 50; // CoinGecko allows up to 50 IDs per request
    for (let i = 0; i < addressesToFetch.length; i += batchSize) {
        const batch = addressesToFetch.slice(i, i + batchSize);
        
        // Get token IDs for this batch
        const tokenIds: string[] = [];
        for (const address of batch) {
            const [tokenId, err] = await getTokenIdFromAddress(address);
            if (!err && tokenId) tokenIds.push(tokenId);
        }

        if (tokenIds.length === 0) continue;

        try {
            const response = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${tokenIds.join(',')}&vs_currencies=usd&include_24hr_change=true&include_market_cap=true`);
            if (!response.ok) {
                if (response.status === 429) {
                    console.warn('CoinGecko API rate limit exceeded during batch fetch');
                    break; // Stop trying to fetch more batches
                }
                continue;
            }
            
            const data: Record<string, CoinGeckoPrice> = await response.json();
            
            // Map back to addresses
            for (const address of batch) {
                const [tokenId] = await getTokenIdFromAddress(address);
                if (tokenId && data[tokenId]) {
                    const priceData = data[tokenId];
                    const tokenPrice: TokenPrice = {
                        usd: priceData.usd,
                        symbol: '',
                        name: ''
                    };
                    prices[address] = tokenPrice;
                    priceCache.set(address, { price: tokenPrice, timestamp: Date.now() });
                }
            }
        } catch (error) {
            console.warn(`Failed to fetch batch prices: ${error}`);
        }
        
        // Add delay between batches to respect rate limits
        if (i + batchSize < addressesToFetch.length) {
            await delay(1200); // 1.2 second delay between batches
        }
    }

    return [prices, null];
} 