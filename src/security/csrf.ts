import * as crypto from 'node:crypto';
import { Context } from '../context.js';

/**
 * XOR two buffers together.
 */
function xor(a: Buffer, b: Buffer): Buffer {
    const result = Buffer.alloc(32);
    for (let i = 0; i < 32; i++) {
        result[i] = a[i] ^ b[i];
    }
    return result;
}

/**
 * Generates a mathematically unpredictable 32-byte secret.
 */
export function generateSecret(): Buffer {
    return crypto.randomBytes(32);
}

/**
 * Generates an XOR-masked Token for BREACH defense.
 * Token format: base64(salt) + "." + base64(secret ^ salt)
 */
export function createToken(secret: Buffer): string {
    const salt = crypto.randomBytes(32); // Use same length as secret for perfect masking
    const masked = xor(secret, salt);
    return `${salt.toString('base64url')}.${masked.toString('base64url')}`;
}

/**
 * Verifies a masked CSRF token against the real secret in a timing-safe manner.
 */
export function verifyToken(token: string, secret: Buffer): boolean {
    if (!token || typeof token !== 'string') return false;
    
    const parts = token.split('.');
    if (parts.length !== 2) return false;

    try {
        const salt = Buffer.from(parts[0], 'base64url');
        const masked = Buffer.from(parts[1], 'base64url');
        
        // Protect against length manipulation attacks
        if (salt.length !== 32 || masked.length !== 32 || secret.length !== 32) return false;
        
        const unmasked = xor(masked, salt);
        
        // Critical: Must use timingSafeEqual to prevent side-channel timing attacks
        return crypto.timingSafeEqual(unmasked, secret);
    } catch {
        return false;
    }
}

export interface CsrfOptions {
    /**
     * Cookie options for the CSRF secret (Stateless Mode).
     */
    cookie?: {
        key?: string;
        sameSite?: 'Strict' | 'Lax' | 'None';
        secure?: boolean;
        httpOnly?: boolean;
        path?: string;
    };
    
    /**
     * Array of exact string paths or Regular Expressions to completely bypass CSRF validation.
     */
    ignore?: (string | RegExp)[];
    
    /**
     * Custom token extractor.
     */
    extractor?: (ctx: Context) => string | undefined | Promise<string | undefined>;
    
    /**
     * Custom error handler for CSRF validation failures.
     */
    errorHandler?: (ctx: Context) => symbol | Promise<symbol>;
    
    /**
     * Stateful Session Adapter. 
     * If provided, the cookie is bypassed and the secret is read/written to the stateful session (e.g., Redis).
     */
    session?: {
        getSecret: (ctx: Context) => Promise<string | null> | string | null;
        setSecret: (ctx: Context, secret: string) => Promise<void> | void;
    };
}

/**
 * Advanced CSRF Middleware that implements Double Submit Cookie (Stateless) OR Synchronizer Token Pattern (Stateful).
 */
export function csrf(options: CsrfOptions = {}) {
    const cookieKey = options.cookie?.key || '__Host-csrf';
    const cookieOptions = {
        sameSite: options.cookie?.sameSite || 'Strict',
        secure: options.cookie?.secure ?? true,
        httpOnly: options.cookie?.httpOnly ?? true,
        path: options.cookie?.path || '/'
    };

    return async (ctx: Context) => {
        // 1. Ignore Route Matching
        if (options.ignore && options.ignore.length > 0) {
            const currentPath = ctx.req.url?.split('?')[0] || '/';
            for (const pattern of options.ignore) {
                if (typeof pattern === 'string' && currentPath === pattern) {
                    return ctx.next();
                } else if (pattern instanceof RegExp && pattern.test(currentPath)) {
                    return ctx.next();
                }
            }
        }

        // 2. Read or generate the CSRF secret (Stateful or Stateless)
        let secretHex: string | null = null;
        
        if (options.session) {
            secretHex = await options.session.getSecret(ctx);
        } else {
            secretHex = await ctx.cookie.get(cookieKey);
        }
        
        let secret: Buffer;
        
        if (!secretHex) {
            secret = generateSecret();
            const hex = secret.toString('hex');
            
            if (options.session) {
                await options.session.setSecret(ctx, hex);
            } else {
                await ctx.cookie.set(cookieKey, hex, cookieOptions);
            }
        } else {
            secret = Buffer.from(secretHex, 'hex');
        }

        // 3. Inject the dynamic XOR-masked token into ctx.locals for the view engine
        const token = createToken(secret);
        ctx.locals.csrfToken = token;

        // 4. Intercept state-changing requests
        const method = ctx.req.method?.toUpperCase();
        if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
            
            let submittedToken: string | undefined = undefined;
            
            // Custom Extractor fallback to default headers/body
            if (options.extractor) {
                submittedToken = await options.extractor(ctx);
            } else {
                submittedToken = ctx.req.headers['x-csrf-token'] as string;
                if (!submittedToken) {
                    try {
                        const bodyPayload = await ctx.body();
                        if (bodyPayload && typeof bodyPayload === 'object' && '_csrf' in bodyPayload) {
                            submittedToken = bodyPayload._csrf as string;
                        }
                    } catch {
                        // Ignore body parsing errors here
                    }
                }
            }

            // 5. Verify mathematically
            if (!submittedToken || !verifyToken(submittedToken, secret)) {
                // If custom error handler exists, use it
                if (options.errorHandler) {
                    return options.errorHandler(ctx);
                }
                
                // Default HTML Forbidden Error
                ctx.status(403);
                return ctx.html('<h1>403 Forbidden - CSRF Verification Failed</h1>');
            }
        }
        
        return ctx.next();
    };
}
