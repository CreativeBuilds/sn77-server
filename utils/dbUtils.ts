import { Database } from 'sqlite';
import { logVoteUpdate } from './logUtils';

export const getAddressMapping = async (
    db: Database,
    ss58: string,
    eth: string,
) => {
    try {
        const row = await db.get('SELECT * FROM address_map WHERE ss58Address = ? AND ethereumAddress = ?', ss58, eth) as any;
        return [row, null];
    } catch (e: any) { return [null, e]; }
};

export const setAddressMapping = async (
    db: Database,
    ss58: string,
    eth: string,
) => {
    try {
        const res = await db.run('INSERT OR REPLACE INTO address_map (ss58Address, ethereumAddress, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)', ss58, eth);
        return [res, null];
    } catch (e: any) { return [null, e]; }
};

export const upsertUserVotes = async (
    db: Database,
    ss58: string,
    pools: { address: string; weight: number }[],
    signature: string,
    message: string,
    blockNumber: number,
    totalWeight: number,
) => {
    try {
        const poolsJson = JSON.stringify(pools);
        const existing = await db.get('SELECT id, block_number, pools FROM user_votes WHERE ss58Address = ?', ss58) as any;
        if (existing && blockNumber <= (existing.block_number ?? 0)) return [null, 'Block number too old'];
        if (!existing) {
            const res = await db.run(
                'INSERT INTO user_votes (ss58Address, pools, signature, message, block_number, total_weight) VALUES (?, ?, ?, ?, ?, ?)',
                ss58, poolsJson, signature, message, blockNumber, totalWeight,
            );
            logVoteUpdate(`NEW VOTE: Address ${ss58} voted for pools: ${poolsJson}`);
            return [res, null];
        }
        
        const oldPools = existing.pools;
        const res = await db.run(
            'UPDATE user_votes SET pools = ?, signature = ?, message = ?, block_number = ?, total_weight = ?, updated_at = CURRENT_TIMESTAMP WHERE ss58Address = ?',
            poolsJson, signature, message, blockNumber, totalWeight, ss58,
        );
        logVoteUpdate(`VOTE OVERWRITE: Address ${ss58} changed votes. OLD: ${oldPools} -> NEW: ${poolsJson}`);
        return [res, null];
    } catch (e: any) { return [null, e]; }
};

export const getUserVotes = async (
    db: Database,
    ss58: string,
) => {
    try {
        const row = await db.get('SELECT * FROM user_votes WHERE ss58Address = ?', ss58) as any;
        if (!row) return [null, null];
        const pools = JSON.parse(row.pools);
        return [{ ...row, pools }, null];
    } catch (e: any) { return [null, e]; }
};

export const getPoolInfo = async (
    db: Database,
    address: string,
) => {
    try {
        const row = await db.get('SELECT * FROM pool_info WHERE address = ?', address.toLowerCase()) as any;
        return [row, null];
    } catch (e: any) { return [null, e]; }
};

export const setPoolInfo = async (
    db: Database,
    address: string,
    token0: string,
    token1: string,
    token0Symbol: string | null,
    token1Symbol: string | null,
    fee: number,
    liquidity: string,
) => {
    try {
        const res = await db.run(
            'INSERT OR REPLACE INTO pool_info (address, token0, token1, token0Symbol, token1Symbol, fee, liquidity, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)',
            address.toLowerCase(), token0.toLowerCase(), token1.toLowerCase(), token0Symbol, token1Symbol, fee, liquidity
        );
        return [res, null];
    } catch (e: any) { return [null, e]; }
};

export const getAllPoolAddresses = async (
    db: Database,
) => {
    try {
        const rows = await db.all('SELECT DISTINCT address FROM pool_info') as any[];
        return [rows.map(row => row.address), null];
    } catch (e: any) { return [null, e]; }
}; 