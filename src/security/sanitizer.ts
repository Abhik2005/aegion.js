export class SanitizerError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'SanitizerError';
    }
}

export class Sanitizer {
    /**
     * Recursively scans objects and arrays for NoSQL injection vectors.
     * If an object key starts with '$', it immediately throws a SanitizerError.
     * This is a Fail-Closed defense.
     */
    static sanitizeNoSQL(payload: any): any {
        if (payload === null || payload === undefined) {
            return payload;
        }

        if (typeof payload === 'object') {
            if (Array.isArray(payload)) {
                for (let i = 0; i < payload.length; i++) {
                    Sanitizer.sanitizeNoSQL(payload[i]);
                }
            } else {
                for (const key in payload) {
                    if (Object.prototype.hasOwnProperty.call(payload, key)) {
                        if (key.startsWith('$')) {
                            throw new SanitizerError(`NoSQL Injection Detected: Illegal key '${key}'`);
                        }
                        Sanitizer.sanitizeNoSQL(payload[key]);
                    }
                }
            }
        }

        return payload;
    }
}
