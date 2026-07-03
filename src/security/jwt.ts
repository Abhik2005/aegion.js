import * as crypto from 'node:crypto';

export interface JwtPayload {
    [key: string]: any;
    exp?: number;
    iat?: number;
}

export class JWTError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'JWTError';
    }
}

/**
 * Base64Url encodes a string or buffer (standard for JWT).
 */
function base64UrlEncode(data: string | Buffer): string {
    const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
    return buffer.toString('base64')
        .replace(/=/g, '')
        .replace(/\+/g, '-')
        .replace(/\//g, '_');
}

/**
 * Mathematical Cryptographic engine for generating and verifying JSON Web Tokens.
 * Built entirely on Node's native C++ crypto bindings to avoid bloated packages.
 */
export const jwt = {
    /**
     * Cryptographically signs a payload into a JWT string.
     * @param payload The data to embed
     * @param secret The secret key (minimum 32 bytes required per RFC 7518)
     * @param expiresInSeconds The lifespan of the token
     */
    sign(payload: object, secret: string, expiresInSeconds: number): string {
        // BUG-27 FIX: Enforce minimum key length per RFC 7518.
        // HS256 requires a key of at least 256 bits (32 bytes).
        // A short secret produces a weak HMAC that is brute-forceable.
        if (!secret || Buffer.byteLength(secret, 'utf8') < 32) {
            throw new JWTError('JWT secret must be at least 32 bytes (256 bits) for HS256 per RFC 7518.');
        }

        const header = { alg: 'HS256', typ: 'JWT' };
        
        const now = Math.floor(Date.now() / 1000);
        const jwtPayload: JwtPayload = {
            ...payload,
            iat: now,
            exp: now + expiresInSeconds
        };

        const encodedHeader = base64UrlEncode(JSON.stringify(header));
        const encodedPayload = base64UrlEncode(JSON.stringify(jwtPayload));
        
        const dataToSign = `${encodedHeader}.${encodedPayload}`;
        const signature = crypto.createHmac('sha256', secret)
                                .update(dataToSign)
                                .digest();
                                
        const encodedSignature = base64UrlEncode(signature);
        
        return `${dataToSign}.${encodedSignature}`;
    },

    /**
     * Mathematically verifies a JWT signature and enforces expiration times.
     * @param token The JWT string
     * @param secret The secret key
     * @returns The decoded payload if mathematically valid. Throws JWTError otherwise.
     */
    verify<T extends object = any>(token: string, secret: string): T & JwtPayload {
        if (!token || typeof token !== 'string') {
            throw new JWTError('Invalid token format');
        }

        const parts = token.split('.');
        if (parts.length !== 3) {
            throw new JWTError('Malformed JWT');
        }

        const [encodedHeader, encodedPayload, encodedSignature] = parts;

        // 1. Re-calculate the mathematical signature
        const dataToSign = `${encodedHeader}.${encodedPayload}`;
        const expectedSignature = crypto.createHmac('sha256', secret)
                                        .update(dataToSign)
                                        .digest();
        const expectedEncodedSignature = base64UrlEncode(expectedSignature);

        // 2. Prevent Timing Attacks via timingSafeEqual
        const providedSigBuffer = Buffer.from(encodedSignature);
        const expectedSigBuffer = Buffer.from(expectedEncodedSignature);
        
        if (providedSigBuffer.length !== expectedSigBuffer.length ||
            !crypto.timingSafeEqual(providedSigBuffer, expectedSigBuffer)) {
            throw new JWTError('Signature verification failed (tampered token)');
        }

        // 3. Decode payload
        let payload: JwtPayload;
        try {
            const decodedPayloadStr = Buffer.from(encodedPayload, 'base64url').toString('utf8');
            payload = JSON.parse(decodedPayloadStr);
        } catch (e) {
            throw new JWTError('Failed to parse JWT payload');
        }

        // 4. BUG-26 FIX: Enforce that exp claim is present.
        // A token without exp would never expire, creating a permanent credential.
        // jwt.sign() always adds exp — but manually crafted tokens bypass this.
        if (!payload.exp) {
            throw new JWTError('Token is missing the expiration claim (exp). Tokens without expiry are not accepted.');
        }

        // 5. Enforce Expiration
        const now = Math.floor(Date.now() / 1000);
        if (now >= payload.exp) {
            throw new JWTError('Token expired');
        }

        return payload as T & JwtPayload;
    }
};
