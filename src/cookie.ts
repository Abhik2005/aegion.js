
import * as http from 'node:http';
import * as crypto from 'node:crypto';

export interface CookieOptions {
    httpOnly?: boolean;
    secure?: boolean;
    maxAge?: number;
    path?: string;
    domain?: string;
    sameSite?: 'Strict' | 'Lax' | 'None';
}

export class CookieManager {
    private parsedCookies: Map<string, string> | null = null;
    private outgoingCookies: string[] = [];

    constructor(
        private req: http.IncomingMessage,
        private res: http.ServerResponse,
        private secretKey?: string
    ) {}

    private parseCookies() {
        if (this.parsedCookies) return;
        this.parsedCookies = new Map();
        const header = this.req.headers.cookie;
        /* c8 ignore next 2 */
        if (!header) return;

        const pairs = header.split(';');
        for (const pair of pairs) {
            const index = pair.indexOf('=');
            if (index > -1) {
                const key = pair.substring(0, index).trim();
                const value = pair.substring(index + 1).trim();
                // Strip quotes if any, then URL-decode the value
                const stripped = value.replace(/^"(.*)"$/, '$1');
                // BUG-15 FIX: Decode URL-encoded values set by this library.
                // Use a try-catch to gracefully handle cookies set by external code
                // that may not be URL-encoded (a literal % not followed by hex).
                try {
                    this.parsedCookies.set(key, decodeURIComponent(stripped));
                } catch {
                    this.parsedCookies.set(key, stripped);
                }
            }
        }
    }

    /**
     * Gets a cookie.
     */
    get(name: string): string | null {
        this.parseCookies();
        return this.parsedCookies!.get(name) || null;
    }

    /**
     * Sets a secure cookie.
     */
    set(name: string, data: any, options: CookieOptions = {}) {
        // BUG-18 FIX: SameSite=None requires Secure=true per RFC 6265bis.
        // Browsers silently reject cookies with SameSite=None; Secure=false.
        if (options.sameSite === 'None' && options.secure === false) {
            throw new Error(
                "Cookie misconfiguration: SameSite=None requires Secure=true. " +
                "Modern browsers will silently reject this cookie."
            );
        }

        let value = typeof data === 'string' ? data : JSON.stringify(data);

        // BUG-15 FIX: URL-encode the value to prevent semicolons and other
        // special characters from injecting fake cookie attributes.
        // e.g., "value; Path=/evil" would otherwise corrupt the Set-Cookie header.
        value = encodeURIComponent(value);

        // BUG-17 FIX: Use Buffer.byteLength (actual UTF-8 bytes) instead of
        // value.length (JS char count). Multibyte characters (e.g. '£', '€')
        // can occupy 2-3 bytes each while counting as 1 JS character, allowing
        // cookies to silently exceed the 4096-byte browser limit.
        if (Buffer.byteLength(value, 'utf8') > 4096) {
            throw new Error(`Cookie payload exceeds 4KB limit for '${name}'.`);
        }

        let cookieString = `${name}=${value}`;
        
        if (options.maxAge !== undefined) cookieString += `; Max-Age=${options.maxAge}`;
        if (options.domain) cookieString += `; Domain=${options.domain}`;
        if (options.path) cookieString += `; Path=${options.path}`;
        else cookieString += `; Path=/`;
        
        if (options.httpOnly !== false) cookieString += `; HttpOnly`;
        if (options.secure !== false) cookieString += `; Secure`;
        
        if (options.sameSite) cookieString += `; SameSite=${options.sameSite}`;
        else cookieString += `; SameSite=Lax`;

        this.outgoingCookies.push(cookieString);
        this.res.setHeader('Set-Cookie', this.outgoingCookies);
    }

    /**
     * Immediately deletes a cookie by expiring it.
     */
    delete(name: string, options: Omit<CookieOptions, 'maxAge'> = {}) {
        this.set(name, '', { ...options, maxAge: 0 });
    }
}
