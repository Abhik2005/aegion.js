
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

    /**
     * Sets an AES-256-GCM encrypted cookie.
     * The value is encrypted and authenticated, so tampering returns null on read.
     * Requires that a cookieSecret was provided to the Server constructor.
     *
     * Cookie format (stored as URL-encoded string):
     *   base64url(iv) + "." + base64url(authTag) + "." + base64url(ciphertext)
     *
     * @param name    - The cookie name
     * @param data    - Any JSON-serializable value (object, string, number, etc.)
     * @param options - Standard CookieOptions (defaults to HttpOnly, Secure, SameSite=Lax)
     */
    setEncrypted(name: string, data: any, options: CookieOptions = {}): void {
        if (!this.secretKey) {
            throw new Error(
                'CookieManager: setEncrypted() requires a cookieSecret to be set in ServerOptions.'
            );
        }

        // Derive a fixed 32-byte AES key from the secret using SHA-256.
        // SHA-256 is appropriate here because the secret is already a
        // high-entropy application secret, not a low-entropy password.
        const key = crypto.createHash('sha256').update(this.secretKey).digest();

        const plaintext = typeof data === 'string' ? data : JSON.stringify(data);

        // 12-byte IV is the GCM standard (96-bit IV for best performance + security).
        const iv = crypto.randomBytes(12);
        const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);

        const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
        // 16-byte GCM auth tag — any bit-flip in the ciphertext invalidates this.
        const authTag = cipher.getAuthTag();

        // Compose as three dot-separated base64url segments (URL-safe, no padding).
        const payload = `${iv.toString('base64url')}.${authTag.toString('base64url')}.${encrypted.toString('base64url')}`;

        this.set(name, payload, options);
    }

    /**
     * Gets and decrypts an AES-256-GCM encrypted cookie.
     * Returns null if the cookie is absent, structurally invalid, or the GCM
     * authentication tag fails (i.e., the cookie was tampered with).
     *
     * @param name - The cookie name
     * @returns The original value (parsed from JSON if applicable), or null
     */
    getEncrypted(name: string): any | null {
        if (!this.secretKey) {
            throw new Error(
                'CookieManager: getEncrypted() requires a cookieSecret to be set in ServerOptions.'
            );
        }

        const raw = this.get(name);
        if (!raw) return null;

        try {
            const parts = raw.split('.');
            if (parts.length !== 3) return null;

            const iv      = Buffer.from(parts[0], 'base64url');
            const authTag = Buffer.from(parts[1], 'base64url');
            const enc     = Buffer.from(parts[2], 'base64url');

            // Reject structurally malformed tokens before attempting decryption.
            if (iv.length !== 12 || authTag.length !== 16) return null;

            const key = crypto.createHash('sha256').update(this.secretKey).digest();
            const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
            decipher.setAuthTag(authTag);

            const decrypted = Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');

            // Best-effort JSON parse — if the original value was a plain string, return it as-is.
            try {
                return JSON.parse(decrypted);
            } catch {
                return decrypted;
            }
        } catch {
            // GCM auth tag failed (tampered) or any other structural error — fail safely.
            return null;
        }
    }
}

