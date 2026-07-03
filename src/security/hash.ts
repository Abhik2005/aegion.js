import * as crypto from 'node:crypto';

export interface ScryptOptions {
    cost?: number; // N parameter (e.g. 16384)
    blockSize?: number; // r parameter (e.g. 8)
    parallelization?: number; // p parameter (e.g. 1)
    keylen?: number; // length of the derived key in bytes (e.g. 64)
}

export class Hash {
    private static readonly DEFAULT_OPTIONS = {
        cost: 16384,          // N: Memory/CPU cost. 16384 is a solid baseline for sub-50ms checks.
        blockSize: 8,         // r: Block size. Standard is 8.
        parallelization: 1,   // p: Parallelization. 1 keeps memory bound tightly.
        keylen: 64            // Derived key length in bytes
    };

    /**
     * Hashes a password using the Peppered Scrypt architecture.
     * 
     * @param password The plain-text password
     * @param pepper The master secret key for this version
     * @param version The identifier for this pepper (default: 1)
     * @param options Optional overrides for Scrypt parameters
     * @returns A secure hash string formatted as `$version$salt$scryptHash`
     */
    static async make(password: string, pepper: string, version: string | number = 1, options?: ScryptOptions): Promise<string> {
        if (typeof password !== 'string' || !password.isWellFormed() || password.length > 256) {
            throw new Error('Invalid password format, encoding, or length (max 256 characters)');
        }
        
        const opts = { ...Hash.DEFAULT_OPTIONS, ...options };
        
        // 1. Lock the password using HMAC-SHA256 and the global Pepper.
        // This ensures the hash cannot be bruteforced offline without the Pepper.
        const hmac = crypto.createHmac('sha256', pepper).update(password).digest('hex');
        
        // 2. Generate a 16-byte random cryptographic Salt per user.
        const salt = crypto.randomBytes(16).toString('hex');
        
        // 3. Apply the memory-hard Scrypt algorithm to defeat GPUs.
        return new Promise((resolve, reject) => {
            crypto.scrypt(
                hmac, 
                salt, 
                opts.keylen, 
                { N: opts.cost, r: opts.blockSize, p: opts.parallelization }, 
                (err, derivedKey) => {
                    if (err) return reject(err);
                    
                    // Format: $version$salt$hash
                    const hashParams = [version, salt, derivedKey.toString('hex')].join('$');
                    resolve(`$${hashParams}`);
                }
            );
        });
    }

    /**
     * Verifies a plain-text password against a Peppered Scrypt hash.
     * 
     * @param password The plain-text password attempt
     * @param hash The stored hash string (`$version$salt$scryptHash`)
     * @param pepperMap A key-value map of { versionId: "pepperString" }
     * @param options Optional overrides for Scrypt parameters (must match what was used during make)
     * @returns boolean True if password is valid, False otherwise
     */
    static async verify(password: string, hash: string, pepperMap: Record<string | number, string>, options?: ScryptOptions): Promise<boolean> {
        // Protect against Type Confusion, Password DoS, and Hash String DoS
        // isWellFormed() prevents UTF-16 unpaired surrogate collision attacks where different invalid chars normalize to the same bytes
        if (typeof password !== 'string' || !password.isWellFormed() || password.length > 256 || typeof hash !== 'string' || hash.length > 512) {
            return false; // Fail safely on type confusion or massive DoS payloads
        }

        const opts = { ...Hash.DEFAULT_OPTIONS, ...options };
        
        // 1. Extract the components from the hash string
        const parts = hash.split('$');
        if (parts.length !== 4 || parts[0] !== '') {
            return false; // Malformed hash format
        }
        
        const version = parts[1];
        const salt = parts[2];
        const derivedKeyHex = parts[3];
        
        // 2. Lookup the corresponding Pepper based on the hash's version ID.
        // If the Pepper was deleted, verification fails safely.
        const pepper = pepperMap[version];
        if (typeof pepper !== 'string') {
            return false; // Unknown pepper version or malicious type confusion (e.g. constructor)
        }
        
        // 3. Repeat the HMAC process using the matched Pepper
        const hmac = crypto.createHmac('sha256', pepper).update(password).digest('hex');
        
        // 4. Repeat the Scrypt process
        return new Promise((resolve, reject) => {
            crypto.scrypt(
                hmac, 
                salt, 
                opts.keylen, 
                { N: opts.cost, r: opts.blockSize, p: opts.parallelization }, 
                (err, derivedKey) => {
                    if (err) return reject(err);
                    
                    const expectedBuf = Buffer.from(derivedKeyHex, 'hex');
                    const actualBuf = derivedKey;
                    
                    if (expectedBuf.length !== actualBuf.length) {
                        return resolve(false);
                    }
                    
                    // 5. Use constant-time comparison to prevent Timing Attacks
                    resolve(crypto.timingSafeEqual(expectedBuf, actualBuf));
                }
            );
        });
    }
}
