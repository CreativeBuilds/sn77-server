import { ApiPromise, WsProvider } from '@polkadot/api';

// Bittensor substrate connection
const BITTENSOR_WS_ENDPOINT = 'wss://entrypoint-finney.opentensor.ai:443';
let bittensorApi: ApiPromise | null = null;

export const initBittensorConnection = async (): Promise<ApiPromise> => {
    if (bittensorApi && bittensorApi.isConnected) return bittensorApi;
    
    try {
        const provider = new WsProvider(BITTENSOR_WS_ENDPOINT);
        bittensorApi = await ApiPromise.create({ provider });
        console.log('Connected to Bittensor substrate node');
        return bittensorApi;
    } catch (error: any) {
        console.error('Failed to connect to Bittensor substrate node:', error);
        throw error;
    }
};

export const fetchCurrentBittensorBlock = async (): Promise<[number, string | null]> => {
    try {
        const api = await initBittensorConnection();
        const header = await api.rpc.chain.getHeader();
        const blockNumber = header.number.toNumber();
        return [blockNumber, null];
    } catch (error: any) {
        console.error('Error fetching Bittensor block number:', error);
        return [0, `Failed to fetch block number: ${error.message}`];
    }
};

export const closeBittensorConnection = async (): Promise<void> => {
    if (bittensorApi && bittensorApi.isConnected) {
        await bittensorApi.disconnect();
        bittensorApi = null;
        console.log('Disconnected from Bittensor substrate node');
    }
};

export const HOTKEYS_CACHE_TTL_MS = 1 * 60 * 1000; // 1 minute
let subnetHotkeysCache: { data: string[]; lastUpdated: number } = { data: [], lastUpdated: 0 };

export const getSubnetHotkeys = () => subnetHotkeysCache.data;

export const initializeSubnetHotkeysCache = async (netuid = 77): Promise<[boolean, string | null]> => {
    console.log(`[INIT] Initializing subnet hotkeys cache for netuid ${netuid}...`);
    const [hotkeys, err] = await fetchSubnetHotkeys(netuid, true);
    if (err) {
        console.error(`[ERROR] Failed to initialize subnet hotkeys cache for netuid ${netuid}:`, err);
        return [false, err];
    }
    subnetHotkeysCache = { data: hotkeys, lastUpdated: Date.now() };
    console.log(`[SUCCESS] Subnet hotkeys cache initialized for netuid ${netuid} with ${hotkeys.length} hotkeys`);
    return [true, null];
};

export const refreshSubnetHotkeysIfNeeded = async (netuid = 77): Promise<void> => {
    if (Date.now() - subnetHotkeysCache.lastUpdated < HOTKEYS_CACHE_TTL_MS) return;
    console.log(`[REFRESH] Refreshing subnet hotkeys cache for netuid ${netuid} (cache expired)...`);
    const [hotkeys, _] = await fetchSubnetHotkeys(netuid, true);
    if (hotkeys.length) {
        const previousCount = subnetHotkeysCache.data.length;
        subnetHotkeysCache = { data: hotkeys, lastUpdated: Date.now() };
        console.log(`[SUCCESS] Subnet hotkeys cache refreshed for netuid ${netuid}: ${previousCount} → ${hotkeys.length} hotkeys`);
    } else {
        console.warn(`[WARN] Failed to refresh subnet hotkeys cache for netuid ${netuid} - keeping existing cache`);
    }
};

export const startPeriodicSubnetHotkeysRefresh = (netuid = 77): void => {
    setInterval(async () => {
        try { await refreshSubnetHotkeysIfNeeded(netuid); } catch (err) { console.error(err); }
    }, 60_000); // check every minute
};

// Add retry configuration constants
const MAX_RETRIES = 3;
const INITIAL_RETRY_DELAY = 500; // 500ms
const MAX_RETRY_DELAY = 5000; // 5 seconds

// Helper function for exponential backoff delay
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

// Helper function to fetch a single UID with retry logic
const fetchSingleHotkey = async (api: ApiPromise, netuid: number, uid: number): Promise<[string | null, string | null]> => {
    let lastError: any = null;
    
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        try {
            // eslint-disable-next-line @typescript-eslint/ban-ts-comment
            // @ts-ignore
            const acc: any = await api.query.subtensorModule.keys(netuid, uid);
            return [acc.toString(), null];
        } catch (error) {
            lastError = error;
            
            if (attempt < MAX_RETRIES) {
                const delay = Math.min(INITIAL_RETRY_DELAY * Math.pow(2, attempt), MAX_RETRY_DELAY);
                console.warn(`[RETRY] UID ${uid} fetch failed (attempt ${attempt + 1}/${MAX_RETRIES + 1}), retrying in ${delay}ms:`, error);
                await sleep(delay);
            }
        }
    }
    
    return [null, `Failed to fetch UID ${uid} after ${MAX_RETRIES + 1} attempts: ${lastError?.message || 'Unknown error'}`];
};

export const fetchSubnetHotkeys = async (netuid: number, skipCache = false): Promise<[string[], string | null]> => {
    if (!skipCache && Date.now() - subnetHotkeysCache.lastUpdated < HOTKEYS_CACHE_TTL_MS && subnetHotkeysCache.data.length) {
        console.log(`[CACHE] Using cached subnet hotkeys for netuid ${netuid} (${subnetHotkeysCache.data.length} hotkeys, age: ${Math.round((Date.now() - subnetHotkeysCache.lastUpdated) / 1000)}s)`);
        return [subnetHotkeysCache.data, null];
    }
    
    console.log(`[FETCH] Fetching subnet hotkeys for netuid ${netuid}...`);
    const startTime = Date.now();
    
    try {
        const api = await initBittensorConnection();
        
        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        // @ts-ignore
        const totalBn = await api.query.subtensorModule.subnetworkN(netuid);
        const total = (totalBn as any).toNumber?.() ?? Number(totalBn);
        
        console.log(`[INFO] Subnet ${netuid} has ${total} total UIDs to fetch`);
        
        if (total === 0) {
            console.warn(`[WARN] Subnet ${netuid} has no UIDs - returning empty array`);
            return [[], null];
        }
        
        const hotkeys: string[] = [];
        const failedUIDs: number[] = [];
        const BATCH = 8; // reduced batch size
        const totalBatches = Math.ceil(total / BATCH);
        
        console.log(`[PROCESS] Processing ${total} UIDs in ${totalBatches} batches of ${BATCH} (with ${MAX_RETRIES + 1} max attempts per UID)...`);
        
        for (let start = 0; start < total; start += BATCH) {
            const currentBatch = Math.floor(start / BATCH) + 1;
            const batchEnd = Math.min(start + BATCH, total);
            const batchSize = batchEnd - start;
            
            console.log(`[BATCH] Processing batch ${currentBatch}/${totalBatches}: UIDs ${start}-${batchEnd - 1} (${batchSize} UIDs)`);
            
            const tasks: Promise<void>[] = [];
            for (let uid = start; uid < batchEnd; uid++) {
                tasks.push(
                    (async () => {
                        const [hotkey, error] = await fetchSingleHotkey(api, netuid, uid);
                        if (hotkey) {
                            hotkeys.push(hotkey);
                        } else {
                            failedUIDs.push(uid);
                            console.error(`[ERROR] Permanently failed to fetch UID ${uid}:`, error);
                        }
                    })(),
                );
            }
            await Promise.all(tasks);
            
            // Progress update every few batches or on completion
            if (currentBatch % 5 === 0 || currentBatch === totalBatches) {
                const progress = Math.round((currentBatch / totalBatches) * 100);
                const failureCount = failedUIDs.length;
                console.log(`[PROGRESS] ${progress}% complete (${hotkeys.length}/${total} hotkeys fetched, ${failureCount} failed)`);
            }
        }
        
        const duration = Date.now() - startTime;
        const successRate = Math.round((hotkeys.length / total) * 100);
        const failureRate = Math.round((failedUIDs.length / total) * 100);
        
        console.log(`[COMPLETE] Subnet ${netuid} hotkey fetch completed:`);
        console.log(`   • Expected UIDs: ${total}`);
        console.log(`   • Fetched hotkeys: ${hotkeys.length}`);
        console.log(`   • Failed UIDs: ${failedUIDs.length}`);
        console.log(`   • Success rate: ${successRate}%`);
        console.log(`   • Failure rate: ${failureRate}%`);
        console.log(`   • Duration: ${duration}ms`);
        console.log(`   • Average: ${Math.round(duration / total)}ms per UID`);
        
        if (failedUIDs.length > 0) {
            console.warn(`[WARN] ${failedUIDs.length} UIDs failed after all retry attempts:`);
            console.warn(`   Failed UIDs: [${failedUIDs.slice(0, 10).join(', ')}${failedUIDs.length > 10 ? `... +${failedUIDs.length - 10} more` : ''}]`);
            
            // If too many failures, might indicate a systemic issue
            if (failureRate > 10) {
                console.error(`[ALERT] High failure rate (${failureRate}%) detected - this may indicate network or API issues`);
            }
        }
        
        if (hotkeys.length !== total) {
            console.warn(`[WARN] Mismatch detected: expected ${total} UIDs but got ${hotkeys.length} hotkeys (${failedUIDs.length} failed)`);
        }
        
        // Only cache if we have reasonable success rate (>90%)
        if (successRate >= 90) {
            subnetHotkeysCache = { data: hotkeys, lastUpdated: Date.now() };
            console.log(`[CACHE] Cached ${hotkeys.length} hotkeys for netuid ${netuid}`);
        } else {
            console.warn(`[WARN] Low success rate (${successRate}%) - not caching incomplete data`);
        }
        
        return [hotkeys, failedUIDs.length > 0 ? `${failedUIDs.length} UIDs failed to fetch` : null];
    } catch (error: any) {
        const duration = Date.now() - startTime;
        console.error(`[ERROR] Error fetching subnet hotkeys for netuid ${netuid} after ${duration}ms:`, error);
        return [[], `Failed to fetch hotkeys for subnet ${netuid}: ${error.message}`];
    }
}; 