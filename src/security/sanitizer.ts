export class SanitizerError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'SanitizerError';
    }
}

export class Sanitizer {
    /**
     * Recursively scans objects and arrays for NoSQL injection vectors.
     * Throws a SanitizerError (Fail-Closed) if any illegal key is found.
     *
     * Detected attack vectors:
     *   1. $ prefix keys  — MongoDB query operators ($gt, $where, $ne, $exists, etc.)
     *      e.g. { "$gt": "" } allows bypassing equality checks entirely.
     *
     *   2. Dot-notation keys — MongoDB interprets "a.b" as a nested field path operator.
     *      An attacker can send { "user.isAdmin": true } to overwrite nested document
     *      fields in $set operations, enabling privilege escalation.
     *      e.g. db.users.updateOne(filter, { $set: body }) with body = { "role.name": "admin" }
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
                        // Vector 1: $ prefix — MongoDB query/update operators
                        if (key.startsWith('$')) {
                            throw new SanitizerError(`NoSQL Injection Detected: Illegal operator key '${key}'`);
                        }
                        // Vector 2: Dot-notation — MongoDB field path traversal
                        if (key.includes('.')) {
                            throw new SanitizerError(`NoSQL Injection Detected: Dot-notation key '${key}' is not allowed (field path traversal)`);
                        }
                        Sanitizer.sanitizeNoSQL(payload[key]);
                    }
                }
            }
        }

        return payload;
    }
}
