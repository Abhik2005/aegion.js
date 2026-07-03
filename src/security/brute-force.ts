import { Context } from '../context.js';

export interface BruteForceOptions {
    /**
     * Maximum number of failed attempts before the account is locked.
     * Default: 5
     */
    maxFailures?: number;
    
    /**
     * How long the account should be locked out in milliseconds.
     * Default: 15 minutes (900000 ms)
     */
    lockoutTimeMs?: number;
    
    /**
     * Custom function to extract the account identifier (e.g., email or username).
     * By default, it looks for `req.body.email` then `req.body.username`.
     */
    identifierExtractor?: (ctx: Context) => string | undefined | Promise<string | undefined>;
    
    /**
     * Maximum number of unique accounts to track in memory to prevent OOM attacks.
     * Default: 100000
     */
    maxMemoryKeys?: number;
    
    /**
     * Custom stateful adapter for tracking failures (e.g., Redis).
     * If not provided, an in-memory Map is used with strict OOM defense.
     */
    store?: {
        getFailures: (id: string) => Promise<{ count: number, resetTime: number } | null> | { count: number, resetTime: number } | null;
        setFailures: (id: string, record: { count: number, resetTime: number }) => Promise<void> | void;
        deleteFailures: (id: string) => Promise<void> | void;
    };
}

/**
 * Advanced Account Lockout Middleware to mathematically prevent Credential Stuffing and Brute Force attacks.
 */
export function bruteForce(options: BruteForceOptions = {}) {
    const maxFailures = options.maxFailures || 5;
    const lockoutTimeMs = options.lockoutTimeMs || 15 * 60 * 1000;
    
    // In-memory store with OOM Defense
    const MAX_KEYS = options.maxMemoryKeys || 100000; 
    const internalStore = new Map<string, { count: number, resetTime: number }>();
    
    // Garbage collection for in-memory store
    if (!options.store) {
        const interval = setInterval(() => {
            const now = Date.now();
            for (const [id, record] of internalStore.entries()) {
                if (now > record.resetTime) {
                    internalStore.delete(id);
                }
            }
        }, Math.min(lockoutTimeMs, 60000));
        
        if (interval.unref) interval.unref();
    }

    const defaultExtractor = async (ctx: Context): Promise<string | undefined> => {
        try {
            const body = await ctx.body();
            if (body && typeof body === 'object') {
                if (typeof body.email === 'string') return body.email;
                if (typeof body.username === 'string') return body.username;
            }
        } catch {
            // Ignore parsing errors
        }
        return undefined;
    };

    return async (ctx: Context) => {
        const extractor = options.identifierExtractor || defaultExtractor;
        let identifier = await extractor(ctx);
        
        if (!identifier) {
            // If we can't extract an identifier, we let it pass, but inject a no-op reset
            ctx.locals.bruteForce = { reset: async () => {} };
            return ctx.next();
        }
        
        // Normalize identifier to prevent bypasses (e.g., ' admin@site.com ' vs 'admin@site.com')
        identifier = identifier.trim().toLowerCase();
        
        let record: { count: number, resetTime: number } | null = null;
        const now = Date.now();
        
        // 1. Retrieve current failure state
        if (options.store) {
            record = await options.store.getFailures(identifier);
        } else {
            record = internalStore.get(identifier) || null;
        }

        // 2. Check if currently locked out
        if (record && record.count >= maxFailures) {
            if (now < record.resetTime) {
                // Account is LOCKED OUT mathematically
                ctx.status(429);
                ctx.res.setHeader('Retry-After', Math.ceil((record.resetTime - now) / 1000));
                ctx.res.setHeader('Content-Type', 'application/json');
                return ctx.json({ error: 'Too Many Failed Attempts. Account Locked.' });
            } else {
                // Lockout time expired, reset the record
                record = null;
            }
        }

        // 3. Increment the failure count BEFORE handler runs (Assume failure by default)
        if (!record) {
            // BUG-65 FIX: Fail-Closed OOM Defense
            // DO NOT evict oldest keys (Cache Eviction Attack). Instead, block all new attempts.
            if (!options.store && internalStore.size >= MAX_KEYS) {
                ctx.status(429);
                ctx.res.setHeader('Retry-After', 60);
                ctx.res.setHeader('Content-Type', 'application/json');
                return ctx.json({ error: 'Too Many Requests' });
            }
            record = { count: 1, resetTime: now + lockoutTimeMs };
        } else {
            record.count += 1;
            // BUG-49 FIX: Do NOT reset resetTime on subsequent attempts.
            // The old code did: record.resetTime = now + lockoutTimeMs;
            // which created a sliding window that a slow attacker (one attempt
            // every lockoutTimeMs-1ms) could exploit to NEVER get locked out.
            // The lockout window is now fixed from the FIRST failure time.
        }

        // 4. Save the failure state
        if (options.store) {
            await options.store.setFailures(identifier, record);
        } else {
            internalStore.set(identifier, record);
        }
        
        // 5. Inject a reset function into context so developers can clear failures on success
        const currentId = identifier; // capture in closure
        ctx.locals.bruteForce = {
            reset: async () => {
                if (options.store) {
                    await options.store.deleteFailures(currentId);
                } else {
                    internalStore.delete(currentId);
                }
            }
        };

        return ctx.next();
    };
}
