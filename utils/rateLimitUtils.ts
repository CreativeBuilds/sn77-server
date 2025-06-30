export const RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 minute window

export const checkRateLimit = (
    key: string,
    storage: Map<string, { count: number; resetTime: number }>,
    limit: number,
): [boolean, string | null] => {
    const now = Date.now();
    const record = storage.get(key);

    if (!record || now > record.resetTime) {
        storage.set(key, { count: 1, resetTime: now + RATE_LIMIT_WINDOW_MS });
        return [true, null];
    }

    if (record.count >= limit) return [false, 'Rate limit exceeded'];

    record.count++;
    return [true, null];
};

export const getClientIP = (request: any): string => {
    return (
        request.headers?.['x-forwarded-for']?.split(',')[0] ||
        request.headers?.['x-real-ip'] ||
        request.socket?.remoteAddress ||
        'unknown'
    );
}; 