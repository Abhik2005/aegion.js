import * as http from 'node:http';
import { z } from 'zod';

// BUG-30 FIX: Use a Symbol key to cache the raw body on the request object.
// This prevents double-stream-read when multiple middlewares call ctx.body()
// (e.g., bruteForce reads body for email/username, then csrf reads body for _csrf token).
const RAW_BODY_CACHE = Symbol('aegion_raw_body_cache');

export class BodyParser {
    /**
     * Extracts the raw string body from the stream with a strict 1MB limit.
     * Caches the result on the request object so the stream is only read once.
     */
    static async parseRawBody(req: http.IncomingMessage, limit: number = 1024 * 1024, timeoutMs: number = 10000): Promise<string> {
        // BUG-30 FIX: Return cached body if already read
        if ((req as any)[RAW_BODY_CACHE] !== undefined) {
            return (req as any)[RAW_BODY_CACHE];
        }

        return new Promise((resolve, reject) => {
            let body = '';
            let size = 0;
            let finished = false;

            const timer = setTimeout(() => {
                /* c8 ignore next */
                if (finished) return;
                finished = true;
                req.destroy();
                reject(new Error('Payload timeout'));
            }, timeoutMs);

            req.on('data', (chunk: Buffer) => {
                /* c8 ignore next */
                if (finished) return;
                size += chunk.length;
                if (size > limit) {
                    finished = true;
                    clearTimeout(timer);
                    req.destroy(); // Instantly kill connection to prevent DoS
                    return reject(new Error('Payload too large'));
                }
                body += chunk.toString();
            });

            req.on('end', () => {
                /* c8 ignore next */
                if (finished) return;
                finished = true;
                clearTimeout(timer);
                // BUG-30 FIX: Cache before resolving
                (req as any)[RAW_BODY_CACHE] = body;
                resolve(body);
            });

            req.on('error', (err) => {
                /* c8 ignore next */
                if (finished) return;
                finished = true;
                clearTimeout(timer);
                reject(err);
            });
        });
    }

    /**
     * Secure Reviver to prevent Prototype Poisoning during JSON parsing.
     */
    static secureReviver(key: string, value: any): any {
        if (key === '__proto__' || key === 'constructor') {
            return undefined; // Destroy malicious keys
        }
        return value;
    }

    /**
     * Parses the body securely based on Content-Type.
     * BUG-10 FIX: Unknown Content-Types return the raw body string instead of
     * attempting JSON.parse and throwing on valid non-JSON data (CSV, XML, etc.)
     */
    static async parseContentType(req: http.IncomingMessage, limit?: number, timeoutMs?: number): Promise<any> {
        const rawBody = await this.parseRawBody(req, limit, timeoutMs);
        /* c8 ignore next 2 */
        if (!rawBody) return {};

        const header = req.headers['content-type'] || '';
        // Extract base MIME type to prevent Spoofing
        const mimeType = header.split(';')[0].trim().toLowerCase();

        try {
            switch (mimeType) {
                case 'application/x-www-form-urlencoded': {
                    // Use native C++ engine to prevent ReDoS
                    const params = new URLSearchParams(rawBody);
                    const obj: Record<string, any> = {};
                    params.forEach((value, key) => {
                        obj[key] = value;
                    });
                    return obj;
                }
                
                case 'text/plain': {
                    return rawBody;
                }

                case '':
                case 'application/json': {
                    // Prevent JSON precision loss attacks (unquoted numbers >= 16 digits)
                    if (/([:\[,]\s*)(-?\d{16,})(?=\s*[,\]}])/.test(rawBody)) {
                        const err = new Error('Invalid payload format: Precision loss detected');
                        (err as any).status = 400;
                        throw err;
                    }
                    // BUG-10 FIX: Only these two cases (explicit JSON or missing Content-Type)
                    // attempt JSON.parse. Missing Content-Type defaults to JSON for backward
                    // compatibility — API clients that omit Content-Type typically send JSON.
                    return JSON.parse(rawBody, this.secureReviver);
                }

                default: {
                    // BUG-10 FIX: Return raw body for genuinely unknown content types
                    // (CSV, XML, binary, custom MIME types, etc.).
                    // Previously fell through to JSON.parse which threw 'Invalid payload format'
                    // on valid non-JSON data. Let the route handler decide what to do with it.
                    return rawBody;
                }
            }
        } catch (e: any) {
            if (e.status) throw e;
            const err = new Error('Invalid payload format');
            (err as any).status = 400;
            throw err;
        }
    }

    /**
     * Parses the body and strictly validates it against a Zod schema.
     */
    static async parseAndValidate<T extends z.ZodTypeAny>(
        req: http.IncomingMessage, 
        schema?: T,
        limit?: number,
        timeoutMs?: number
    ): Promise<z.infer<T> | any> {
        const data = await this.parseContentType(req, limit, timeoutMs);
        /* c8 ignore next 2 */
        if (!schema) return data;
        
        try {
            return schema.parse(data);
        } catch (error: any) {
            if (error instanceof z.ZodError) {
                const err = new Error('Validation failed');
                (err as any).status = 400;
                (err as any).errors = error.issues;
                throw err;
            }
            /* c8 ignore next 2 */
            throw error;
        }
    }
}
