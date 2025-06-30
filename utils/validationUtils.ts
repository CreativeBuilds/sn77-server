export const validateBasicInput = (
    signature: string,
    message: string,
    address: string,
    maxSignatureLength = 1000,
    maxMessageLength = 10000,
    maxAddressLength = 100,
): [boolean, string | null] => {
    if (!signature || !message || !address) return [false, 'Missing required fields'];
    if (signature.length > maxSignatureLength) return [false, 'Signature too long'];
    if (message.length > maxMessageLength) return [false, 'Message too long'];
    if (address.length > maxAddressLength) return [false, 'Address too long'];

    // Basic address format validation
    if (!/^[a-zA-Z0-9]+$/.test(address.replace(/[.\-_]/g, ''))) return [false, 'Invalid address format'];

    return [true, null];
};

export const normalizeWeights = (
    pools: { address: string; weight: number }[],
): [{ address: string; weight: number }[], string | null] => {
    if (pools.length === 0) return [[], 'No pools provided'];

    // Filter out zero or negative weights
    const validPools = pools.filter((pool) => pool.weight > 0);
    if (validPools.length === 0) return [[], 'All pool weights are zero or negative'];

    // Calculate total weight
    const totalWeight = validPools.reduce((sum, pool) => sum + pool.weight, 0);
    if (totalWeight <= 0) return [[], 'Total weight must be positive'];

    // Normalize weights to sum to 1
    const normalizedPools = validPools.map((pool) => ({
        address: pool.address,
        weight: pool.weight / totalWeight,
    }));

    return [normalizedPools, null];
}; 