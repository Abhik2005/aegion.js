import { CookieManager, CookieOptions } from './cookie.js';
import { jwt, JWTError, JwtPayload } from './security/jwt.js';

export interface SessionConfig {
    /** Access Token lifespan in seconds (Default: 15 minutes = 900) */
    accessExpiresIn?: number;
    /** Refresh Token lifespan in seconds (Default: 7 days = 604800) */
    refreshExpiresIn?: number;
    /** Allows overriding the highly secure default cookie flags. USE WITH EXTREME CAUTION. */
    cookieOptions?: Partial<CookieOptions>;
}

export class SessionManager {
    private cookie: CookieManager;
    private secretKey: string;
    
    // Developer Freedom: Smart Defaults
    private accessExpiresIn: number = 900; // 15 mins
    private refreshExpiresIn: number = 604800; // 7 days
    
    // Locked down, mathematically bulletproof defaults
    private defaultCookieOptions: CookieOptions = {
        httpOnly: true,
        sameSite: 'Strict',
        secure: process.env.NODE_ENV === 'production',
        path: '/'
    };

    constructor(cookieManager: CookieManager, secretKey: string, config?: SessionConfig) {
        if (!secretKey || secretKey.length < 32) {
            throw new Error("SessionManager requires a cryptographically strong secretKey (minimum 32 chars).");
        }
        
        this.cookie = cookieManager;
        this.secretKey = secretKey;
        
        if (config) {
            if (config.accessExpiresIn) this.accessExpiresIn = config.accessExpiresIn;
            if (config.refreshExpiresIn) this.refreshExpiresIn = config.refreshExpiresIn;
            if (config.cookieOptions) {
                this.defaultCookieOptions = { ...this.defaultCookieOptions, ...config.cookieOptions };
            }
        }
    }

    /**
     * Issues a dual-token (Access & Refresh) and attaches them as secure cookies.
     * @param payload The user data to store in the session
     */
    public create(payload: object) {
        const accessToken = jwt.sign(payload, this.secretKey, this.accessExpiresIn);
        const refreshToken = jwt.sign({ _rotate: true, payload }, this.secretKey, this.refreshExpiresIn);

        this.cookie.set('aegion_access', accessToken, {
            ...this.defaultCookieOptions,
            maxAge: this.accessExpiresIn
        });

        this.cookie.set('aegion_refresh', refreshToken, {
            ...this.defaultCookieOptions,
            maxAge: this.refreshExpiresIn
        });
    }

    /**
     * Retrieves the session payload. 
     * If the Access token is expired but the Refresh token is valid, it automatically rotates them.
     */
    public get<T extends object = any>(): T | null {
        const accessToken = this.cookie.get('aegion_access');
        
        if (accessToken && typeof accessToken === 'string') {
            try {
                // If it's valid, instantly return payload (Zero DB lookups!)
                const decoded = jwt.verify<T>(accessToken, this.secretKey);
                // Strip out JWT specific claims before giving it to developer
                const { iat, exp, ...payload } = decoded;
                return payload as T;
            } catch (err: any) {
                // If it's tampered, instantly reject.
                if (err.message !== 'Token expired') {
                    this.destroy();
                    return null;
                }
                // If it's expired, we fall through to attempt Refresh rotation
            }
        }

        // --- Stateless JWT Rotation ---
        const refreshToken = this.cookie.get('aegion_refresh');
        /* c8 ignore next */
        if (refreshToken === null) return null;

        try {
            const decodedRefresh = jwt.verify<{ _rotate: boolean, payload: T }>(refreshToken, this.secretKey);
            
            // Generate a fresh set of tokens seamlessly (Rotation)
            this.create(decodedRefresh.payload);
            
            return decodedRefresh.payload;
        } catch (err) {
            // Refresh token is expired or tampered. Complete logout.
            this.destroy();
            return null;
        }
    }

    /**
     * Instantly wipes all session cookies, mathematically logging the user out.
     */
    public destroy() {
        this.cookie.delete('aegion_access', { path: this.defaultCookieOptions.path });
        this.cookie.delete('aegion_refresh', { path: this.defaultCookieOptions.path });
    }
}
