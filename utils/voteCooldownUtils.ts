import { Database } from 'sqlite';

export interface VoteChangeRecord {
    ss58Address: string;
    oldPools: string;
    newPools: string;
    changeTimestamp: Date;
    cooldownUntil: Date | null;
    changeCount: number;
}

export const checkVoteCooldown = async (
    db: Database,
    ss58Address: string,
    newPools: string
): Promise<[boolean, string | null, number | null]> => {
    try {
        // Check if user has any existing votes
        const existingVote = await db.get(
            'SELECT pools FROM user_votes WHERE ss58Address = ?',
            ss58Address
        ) as any;

        if (!existingVote) {
            // First time voting, no cooldown before voting but will get base 72m cooldown after
            // Next vote will be progressive (144m) if within 24h
            return [true, null, VOTE_CHANGE_COOLDOWN_MS];
        }

        const oldPools = existingVote.pools;
        if (oldPools === newPools) {
            // No change in votes, no cooldown but will get cooldown after
            return [true, null, VOTE_CHANGE_COOLDOWN_MS];
        }

        // Check if user is currently in cooldown
        const cooldownRecord = await db.get(
            'SELECT cooldown_until, change_count, change_timestamp FROM vote_change_history WHERE ss58Address = ? ORDER BY change_timestamp DESC LIMIT 1',
            ss58Address
        ) as any;

        if (cooldownRecord && cooldownRecord.cooldown_until) {
            const cooldownUntil = new Date(cooldownRecord.cooldown_until);
            const now = new Date();
            
            if (now < cooldownUntil) {
                const remainingMs = cooldownUntil.getTime() - now.getTime();
                const remainingMinutes = Math.ceil(remainingMs / (1000 * 60));
                return [false, `Vote change blocked. Cooldown active for ${remainingMinutes} more minutes.`, null];
            }
        }

        // Check if cooldown should reset due to inactivity
        let effectiveChangeCount = 0;
        if (cooldownRecord && cooldownRecord.change_timestamp) {
            const lastChangeTime = new Date(cooldownRecord.change_timestamp);
            const now = new Date();
            const timeSinceLastChange = now.getTime() - lastChangeTime.getTime();
            
            // If more than 24 hours since last change, reset change count
            if (timeSinceLastChange > COOLDOWN_RESET_PERIOD_MS) {
                effectiveChangeCount = 0;
            } else {
                effectiveChangeCount = cooldownRecord.change_count;
            }
        }

        // Calculate new cooldown duration based on what the count will be after this vote
        const cooldownDuration = calculateCooldownDuration(effectiveChangeCount + 1);
        
        return [true, null, cooldownDuration];
    } catch (error) {
        return [false, `Database error: ${error}`, null];
    }
};

export const recordVoteChange = async (
    db: Database,
    ss58Address: string,
    oldPools: string,
    newPools: string,
    cooldownDuration: number
): Promise<[boolean, string | null]> => {
    try {
        console.log(`[DEBUG] recordVoteChange called for ${ss58Address}`);
        console.log(`[DEBUG] oldPools: ${oldPools}`);
        console.log(`[DEBUG] newPools: ${newPools}`);
        console.log(`[DEBUG] cooldownDuration: ${cooldownDuration}ms`);
        
        const now = new Date();
        const cooldownUntil = new Date(now.getTime() + cooldownDuration);

        // Get current change count and check if it should reset
        const currentRecord = await db.get(
            'SELECT change_count, change_timestamp FROM vote_change_history WHERE ss58Address = ? ORDER BY change_timestamp DESC LIMIT 1',
            ss58Address
        ) as any;

        let changeCount = 1; // Default to 1 for new changes
        
        if (currentRecord && currentRecord.change_timestamp) {
            const lastChangeTime = new Date(currentRecord.change_timestamp);
            const timeSinceLastChange = now.getTime() - lastChangeTime.getTime();
            
            // If more than 24 hours since last change, reset change count
            if (timeSinceLastChange > COOLDOWN_RESET_PERIOD_MS) {
                changeCount = 1; // Reset to 1
                console.log(`[DEBUG] Reset change count to 1 for ${ss58Address} (24h+ since last change)`);
            } else {
                changeCount = currentRecord.change_count + 1;
                console.log(`[DEBUG] Incremented change count to ${changeCount} for ${ss58Address}`);
            }
        } else {
            console.log(`[DEBUG] First vote change record for ${ss58Address}, change count = 1`);
        }

        console.log(`[DEBUG] Inserting vote change record for ${ss58Address}:`);
        console.log(`[DEBUG] - ss58Address: ${ss58Address}`);
        console.log(`[DEBUG] - old_pools: ${oldPools}`);
        console.log(`[DEBUG] - new_pools: ${newPools}`);
        console.log(`[DEBUG] - change_timestamp: ${now.toISOString()}`);
        console.log(`[DEBUG] - cooldown_until: ${cooldownUntil.toISOString()}`);
        console.log(`[DEBUG] - change_count: ${changeCount}`);

        // Insert new change record
        const result = await db.run(
            'INSERT INTO vote_change_history (ss58Address, old_pools, new_pools, change_timestamp, cooldown_until, change_count) VALUES (?, ?, ?, ?, ?, ?)',
            ss58Address, oldPools, newPools, now.toISOString(), cooldownUntil.toISOString(), changeCount
        );
        
        console.log(`[DEBUG] Vote change record inserted successfully for ${ss58Address}, result:`, result);
        return [true, null];
    } catch (error) {
        console.error(`[ERROR] Failed to record vote change for ${ss58Address}:`, error);
        return [false, `Failed to record vote change: ${error}`];
    }
};

export const getVoteChangeHistory = async (
    db: Database,
    ss58Address: string
): Promise<[VoteChangeRecord[] | null, string | null]> => {
    try {
        const rows = await db.all(
            'SELECT * FROM vote_change_history WHERE ss58Address = ? ORDER BY change_timestamp DESC',
            ss58Address
        ) as any[];

        const history = rows.map(row => ({
            ss58Address: row.ss58Address,
            oldPools: row.old_pools,
            newPools: row.new_pools,
            changeTimestamp: new Date(row.change_timestamp),
            cooldownUntil: row.cooldown_until ? new Date(row.cooldown_until) : null,
            changeCount: row.change_count
        }));

        return [history, null];
    } catch (error) {
        return [null, `Failed to fetch vote change history: ${error}`];
    }
};

export const cleanupExpiredCooldowns = async (db: Database): Promise<[boolean, string | null]> => {
    try {
        const now = new Date().toISOString();
        await db.run(
            'DELETE FROM vote_change_history WHERE cooldown_until < ?',
            now
        );
        return [true, null];
    } catch (error) {
        return [false, `Failed to cleanup expired cooldowns: ${error}`];
    }
};

export const checkVoteCooldownStatus = async (
    db: Database,
    ss58Address: string
): Promise<[any, string | null]> => {
    try {
        // Check if user is currently in cooldown
        const cooldownRecord = await db.get(
            'SELECT cooldown_until, change_count, change_timestamp FROM vote_change_history WHERE ss58Address = ? ORDER BY change_timestamp DESC LIMIT 1',
            ss58Address
        ) as any;

        if (!cooldownRecord || !cooldownRecord.cooldown_until) {
            return [{ active: false, remainingTime: null, remainingMinutes: null, timeDisplay: null, cooldownUntil: null, changeCount: 0, nextCooldownDuration: '72m' }, null];
        }

        const cooldownUntil = new Date(cooldownRecord.cooldown_until);
        const now = new Date();
        
        if (now < cooldownUntil) {
            const remainingMs = cooldownUntil.getTime() - now.getTime();
            const remainingMinutes = Math.ceil(remainingMs / (1000 * 60));
            const remainingHours = Math.floor(remainingMs / (1000 * 60 * 60));
            const remainingMinutesOnly = Math.floor((remainingMs % (1000 * 60 * 60)) / (1000 * 60));
            
            let timeDisplay = '';
            if (remainingHours > 0) {
                timeDisplay = `${remainingHours}h ${remainingMinutesOnly}m`;
            } else {
                timeDisplay = `${remainingMinutes}m`;
            }

            // Calculate what the next cooldown would be (based on what count will be after next vote)
            const nextCooldownDuration = calculateCooldownDuration(cooldownRecord.change_count + 1);
            const nextCooldownMinutes = Math.ceil(nextCooldownDuration / (1000 * 60));
            const nextCooldownDisplay = nextCooldownMinutes >= 60 ? 
                `${Math.floor(nextCooldownMinutes / 60)}h ${nextCooldownMinutes % 60}m` : 
                `${nextCooldownMinutes}m`;
            
            return [{
                active: true,
                remainingTime: remainingMs,
                remainingMinutes,
                remainingHours,
                timeDisplay,
                cooldownUntil: cooldownUntil.toISOString(),
                changeCount: cooldownRecord.change_count,
                nextCooldownDuration: nextCooldownDisplay
            }, null];
        }

        // Calculate what the next cooldown would be (based on what count will be after next vote)
        const nextCooldownDuration = calculateCooldownDuration(cooldownRecord.change_count + 1);
        const nextCooldownMinutes = Math.ceil(nextCooldownDuration / (1000 * 60));
        const nextCooldownDisplay = nextCooldownMinutes >= 60 ? 
            `${Math.floor(nextCooldownMinutes / 60)}h ${nextCooldownMinutes % 60}m` : 
            `${nextCooldownMinutes}m`;

        return [{ 
            active: false, 
            remainingTime: null, 
            remainingMinutes: null, 
            timeDisplay: null, 
            cooldownUntil: null, 
            changeCount: cooldownRecord.change_count,
            nextCooldownDuration: nextCooldownDisplay
        }, null];
    } catch (error) {
        return [null, `Database error: ${error}`];
    }
};

const calculateCooldownDuration = (changeCount: number): number => {
    if (changeCount < FREQUENT_CHANGE_THRESHOLD) {
        return VOTE_CHANGE_COOLDOWN_MS;
    }

    // Progressive cooldown: double the duration for each frequent change
    const multiplier = Math.pow(PROGRESSIVE_COOLDOWN_MULTIPLIER, changeCount - FREQUENT_CHANGE_THRESHOLD + 1);
    const duration = VOTE_CHANGE_COOLDOWN_MS * multiplier;
    
    // Cap at maximum cooldown (8 hours)
    return Math.min(duration, MAX_COOLDOWN_MS);
};

// Constants
const VOTE_CHANGE_COOLDOWN_MS = 72 * 60 * 1000; // 72 minutes base cooldown
const PROGRESSIVE_COOLDOWN_MULTIPLIER = 2; // Double cooldown for each frequent change
const MAX_COOLDOWN_MS = 8 * 60 * 60 * 1000; // Max 8 hours cooldown
const FREQUENT_CHANGE_THRESHOLD = 2; // Changes within this threshold trigger progressive cooldown
const COOLDOWN_RESET_PERIOD_MS = 24 * 60 * 60 * 1000; // 24 hours of inactivity resets change count 