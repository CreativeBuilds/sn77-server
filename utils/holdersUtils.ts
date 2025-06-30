import { delay } from './miscUtils';
import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { ApiPromise } from '@polkadot/api';
import { initBittensorConnection } from './bittensorUtils';
import { u128 } from '@polkadot/types/primitive';

export const HOLDERS_CACHE_TTL_MS = 1 * 60 * 1000; // 1 minute
const HOLDERS_REFRESH_CHECK_INTERVAL_MS = 60 * 1000; // 1 minute

let holdersCache: { data: any; lastUpdated: number } = { data: null, lastUpdated: 0 };

const saveHoldersToCSV = (holders: any[], netuid: number): [boolean, string | null] => {
    try {
        if (!process.env.LOG_CSV || process.env.LOG_CSV !== 'true') return [true, null];
        
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const filename = `holders_sn${netuid}_${timestamp}.csv`;
        const logsDir = 'logs';
        
        // Create logs directory if it doesn't exist
        try { mkdirSync(logsDir, { recursive: true }); } catch (_) { }
        
        // Create CSV content
        const headers = ['address', 'alphaBalanceRaw', 'taoBalanceRaw', 'subnetRank'];
        const csvContent = [
            headers.join(','),
            ...holders.map(holder => [
                holder.address,
                holder.alphaBalanceRaw,
                holder.taoBalanceRaw,
                holder.subnetRank
            ].join(','))
        ].join('\n');
        
        const filepath = join(logsDir, filename);
        writeFileSync(filepath, csvContent, 'utf8');
        
        console.log(`Holders data saved to CSV: ${filepath}`);
        return [true, null];
    } catch (error) {
        return [false, `Failed to save CSV: ${error}`];
    }
};

export const fetchAllHolders = async (): Promise<[any[], string | null]> => {
    console.log('Fetching holders data directly from the chain...');
    
    let api: ApiPromise;
    try {
        api = await initBittensorConnection();
    } catch (e) {
        return [[], `Failed to connect to Bittensor network: ${e}`];
    }

    const netuid = 77; // Alpha token subnet

    console.log(`Fetching all hotkeys with stake on subnet ${netuid}...`);
    let allHotkeysWithStakeRaw: [any, u128][];
    try {
        // This will fetch all hotkeys across ALL subnets, then we filter.
        allHotkeysWithStakeRaw = await api.query.subtensorModule.totalHotkeyAlpha.entries();
    } catch (e) {
        return [[], `Failed to fetch hotkeys from TotalHotkeyAlpha map: ${e}`];
    }
    
    const hotkeysWithStake = allHotkeysWithStakeRaw
        .filter(([{ args }]) => {
            const [_hotkey, key_netuid] = args;
            return key_netuid.toNumber() === netuid;
        })
        .map(([{ args }, value]) => ({
            hotkey: args[0].toString(),
            total_hotkey_alpha_raw: value,
        }));
        
    console.log(`Found ${hotkeysWithStake.length} hotkeys with stake on subnet ${netuid}.`);

    const holderBalances = new Map<string, { alpha: bigint, tao: bigint }>();

    const tao_in_raw = await api.query.subtensorModule.subnetTAO(netuid);
    const alpha_in_raw = await api.query.subtensorModule.subnetAlphaIn(netuid);
    
    const tao_in = (tao_in_raw as u128).toBigInt();
    const alpha_in = (alpha_in_raw as u128).toBigInt();

    const scaleFactor = BigInt(1e18);
    const price = alpha_in > 0 ? (tao_in * scaleFactor) / alpha_in : BigInt(0);

    let hotkeysProcessed = 0;
    for (const { hotkey, total_hotkey_alpha_raw } of hotkeysWithStake) {
        hotkeysProcessed++;
        console.log(`Processing hotkey ${hotkeysProcessed}/${hotkeysWithStake.length}: ${hotkey}`);
        
        const total_hotkey_shares_raw = await api.query.subtensorModule.totalHotkeyShares(hotkey, netuid);
        
        const total_hotkey_alpha = total_hotkey_alpha_raw.toBigInt();
        
        const total_hotkey_shares = BigInt((total_hotkey_shares_raw.toJSON() as { bits: string | number }).bits);
        
        if (total_hotkey_shares === BigInt(0)) continue;

        // The 'alpha' map has keys (hotkey, coldkey, netuid).
        // We get all stakes for the current hotkey and then filter by our target netuid.
        const all_stakes_for_hotkey = await api.query.subtensorModule.alpha.entries(hotkey);

        for (const [storageKey, alpha_share_raw] of all_stakes_for_hotkey) {
            const [_hotkey_arg, coldkey_arg, stake_netuid_arg] = storageKey.args;
            
            if ((stake_netuid_arg as any).toNumber() !== netuid) {
                continue;
            }

            const coldkey = coldkey_arg.toString();
            const alpha_share = BigInt((alpha_share_raw.toJSON() as { bits: string | number }).bits);

            const alpha_unscaled = (alpha_share * total_hotkey_alpha) / total_hotkey_shares;
            
            const alpha_final = alpha_unscaled / BigInt(1e9);
            const tao = (alpha_final * price) / scaleFactor;

            const current = holderBalances.get(coldkey) || { alpha: BigInt(0), tao: BigInt(0) };
            current.alpha += alpha_final;
            current.tao += tao;
            holderBalances.set(coldkey, current);
        }
    }

    const processed = Array.from(holderBalances.entries()).map(([address, balances]) => ({
        address,
        alphaBalanceRaw: balances.alpha.toString(),
        taoBalanceRaw: balances.tao.toString(),
        subnetRank: null,
    }));

    console.log(`Successfully fetched and aggregated ${processed.length} holders from the chain.`);
    
    const [csvSaved, csvError] = saveHoldersToCSV(processed, netuid);
    if (!csvSaved) console.warn('CSV save warning:', csvError);
    
    return [processed, null];
};

export const initializeHoldersCache = async (): Promise<[boolean, string | null]> => {
    console.log('Initializing holders cache...');
    const startTime = Date.now();
    
    const [holders, err] = await fetchAllHolders();
    if (err) {
        console.error('Failed to fetch holders during initialization:', err);
        return [false, err];
    }
    
    const initTime = Date.now() - startTime;
    console.log(`Holders cache initialization completed in ${initTime}ms`);
    console.log(`Caching ${holders.length} holders...`);
    
    holdersCache = { data: holders, lastUpdated: Date.now() };
    return [true, null];
};

export const refreshHoldersCacheIfNeeded = async (): Promise<void> => {
    const now = Date.now();
    const cacheAge = now - holdersCache.lastUpdated;
    console.log(`Checking if holders cache needs refresh (age: ${Math.round(cacheAge / 1000)}s, TTL: ${Math.round(HOLDERS_CACHE_TTL_MS / 1000)}s)`);
    
    if (now - holdersCache.lastUpdated > HOLDERS_CACHE_TTL_MS) {
        console.log('Holders cache expired, refreshing...');
        const [holders, err] = await fetchAllHolders();
        if (!err) {
            console.log('Holders cache refreshed successfully');
            holdersCache = { data: holders, lastUpdated: now };
        } else {
            console.error('Failed to refresh holders cache:', err);
        }
    } else {
        console.log('Holders cache is still fresh, skipping refresh');
    }
};

export const startPeriodicHoldersRefresh = (): void => {
    setInterval(async () => {
        try { await refreshHoldersCacheIfNeeded(); } catch (err) { console.error(err); }
    }, HOLDERS_REFRESH_CHECK_INTERVAL_MS);
};

export const getHolders = () => holdersCache.data; 