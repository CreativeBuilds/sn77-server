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
            // First time voting, no cooldown
            return [true, null, null];
        }

        const oldPools = existingVote.pools;
        if (oldPools === newPools) {
            // No change in votes, no cooldown
            return [true, null, null];
        }

        // Check if user is currently in cooldown
        const cooldownRecord = await db.get(
            'SELECT cooldown_until, change_count FROM vote_change_history WHERE ss58Address = ? ORDER BY change_timestamp DESC LIMIT 1',
            ss58Address
        ) as any;

        if (cooldownRecord && cooldownRecord.cooldown_until) {
            const cooldownUntil = new Date(cooldownRecord.cooldown_until);
            const now = new Date();
            
            if (now < cooldownUntil) {
                const remainingMs = cooldownUntil.getTime() - now.getTime();
                const remainingHours = Math.ceil(remainingMs / (1000 * 60 * 60));
                return [false, `Vote change blocked. Cooldown active for ${remainingHours} more hours.`, null];
            }
        }

        // Calculate new cooldown duration
        const changeCount = cooldownRecord ? cooldownRecord.change_count : 0;
        const cooldownDuration = calculateCooldownDuration(changeCount);
        
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
        const now = new Date();
        const cooldownUntil = new Date(now.getTime() + cooldownDuration);

        // Get current change count
        const currentRecord = await db.get(
            'SELECT change_count FROM vote_change_history WHERE ss58Address = ? ORDER BY change_timestamp DESC LIMIT 1',
            ss58Address
        ) as any;

        const changeCount = currentRecord ? currentRecord.change_count + 1 : 1;

        // Insert new change record
        await db.run(
            'INSERT INTO vote_change_history (ss58Address, old_pools, new_pools, change_timestamp, cooldown_until, change_count) VALUES (?, ?, ?, ?, ?, ?)',
            ss58Address, oldPools, newPools, now.toISOString(), cooldownUntil.toISOString(), changeCount
        );

        return [true, null];
    } catch (error) {
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
            'SELECT cooldown_until, change_count FROM vote_change_history WHERE ss58Address = ? ORDER BY change_timestamp DESC LIMIT 1',
            ss58Address
        ) as any;

        if (!cooldownRecord || !cooldownRecord.cooldown_until) {
            return [{ active: false, remainingTime: null, changeCount: 0 }, null];
        }

        const cooldownUntil = new Date(cooldownRecord.cooldown_until);
        const now = new Date();
        
        if (now < cooldownUntil) {
            const remainingMs = cooldownUntil.getTime() - now.getTime();
            const remainingMinutes = Math.ceil(remainingMs / (1000 * 60));
            const remainingHours = Math.floor(remainingMs / (1000 * 60 * 60));
            const remainingMinutesOnly = remainingMinutes % 60;
            
            let timeDisplay = '';
            if (remainingHours > 0) {
                timeDisplay = `${remainingHours}h ${remainingMinutesOnly}m`;
            } else {
                timeDisplay = `${remainingMinutes}m`;
            }
            
            return [{
                active: true,
                remainingTime: remainingMs,
                remainingMinutes,
                remainingHours,
                timeDisplay,
                cooldownUntil: cooldownUntil.toISOString(),
                changeCount: cooldownRecord.change_count
            }, null];
        }

        return [{ active: false, remainingTime: null, changeCount: cooldownRecord.change_count }, null];
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
    
    // Cap at maximum cooldown
    return Math.min(duration, MAX_COOLDOWN_MS);
};

// Constants (these should match the ones in server.ts)
const VOTE_CHANGE_COOLDOWN_MS = 72 * 60 * 1000; // 72 minutes base cooldown
const PROGRESSIVE_COOLDOWN_MULTIPLIER = 2; // Double cooldown for each frequent change
const MAX_COOLDOWN_MS = 24 * 60 * 60 * 1000; // Max 24 hours cooldown
const FREQUENT_CHANGE_THRESHOLD = 3; // Changes within this threshold trigger progressive cooldown 