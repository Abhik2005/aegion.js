import * as http from 'node:http';

export interface RateLimitOptions {
    windowMs: number;
    maxRequests: number;
    trustProxy?: boolean;
    /**
     * Maximum unique IPs to track in memory.
     * Prevents OOM under a DDoS IP-flooding attack.
     * Default: 500_000
     */
    maxKeys?: number;
}

export class RateLimiter {
    private store: Map<string, { count: number, resetTime: number }> = new Map();
    // BUG-23 FIX: Cap the store size to prevent OOM under IP-flooding DDoS.
    // Without this, 1M unique IPs × ~100 bytes = 100MB before cleanup fires.
    private readonly MAX_KEYS: number;

    constructor(private options: RateLimitOptions) {
        this.MAX_KEYS = options.maxKeys ?? 500_000;
        // Cleanup interval to prevent memory leaks
        const interval = setInterval(() => this.cleanup(), options.windowMs);
        if (interval.unref) interval.unref();
    }

    private getIp(req: http.IncomingMessage): string {
        if (this.options.trustProxy) {
            const forwarded = req.headers['x-forwarded-for'];
            if (typeof forwarded === 'string') {
                // BUG-22 FIX: Use the LAST IP in the chain, not the first.
                // When behind a trusted reverse proxy, the proxy appends the real
                // client IP as the last entry. The first entry can be freely spoofed
                // by the attacker to bypass per-IP rate limiting.
                const ips = forwarded.split(',').map(s => s.trim());
                return ips[ips.length - 1];
            }
        }
        return req.socket.remoteAddress || 'unknown';
    }

    /**
     * Checks if the request is allowed. Returns true if allowed, false if rate limited.
     */
    check(req: http.IncomingMessage, res: http.ServerResponse): boolean {
        const ip = this.getIp(req);
        const now = Date.now();

        let record = this.store.get(ip);

        if (!record || now > record.resetTime) {
            // BUG-65 FIX: Apply OOM cap before inserting a new record.
            // If the store is full, DO NOT evict the oldest key (Cache Eviction Attack).
            // Instead, block ALL new untracked IPs until the cleanup interval runs.
            if (!record && this.store.size >= this.MAX_KEYS) {
                res.setHeader('Retry-After', 60);
                res.statusCode = 429;
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ error: 'Too Many Requests' }));
                return false;
            }
            record = { count: 1, resetTime: now + this.options.windowMs };
            this.store.set(ip, record);
            return true;
        }

        record.count += 1;

        if (record.count > this.options.maxRequests) {
            res.setHeader('Retry-After', Math.ceil((record.resetTime - now) / 1000));
            res.statusCode = 429;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: 'Too Many Requests' }));
            return false;
        }

        return true;
    }

    private cleanup() {
        const now = Date.now();
        for (const [ip, record] of this.store.entries()) {
            if (now > record.resetTime) {
                this.store.delete(ip);
            }
        }
    }
}
