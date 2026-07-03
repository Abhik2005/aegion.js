import { test, describe } from 'node:test';
import * as assert from 'node:assert';
import * as http from 'node:http';
import { Socket } from 'node:net';
import { Sanitizer, SanitizerError } from '../src/security/sanitizer.js';
import { Server } from '../src/server.js';
import { Context } from '../src/context.js';

describe('NoSQL Sanitization Pipeline', () => {
    test('should allow perfectly valid JSON without throwing', () => {
        const payload = {
            username: 'admin',
            age: 25,
            roles: ['user', 'admin'],
            metadata: { location: 'USA' }
        };
        const result = Sanitizer.sanitizeNoSQL(payload);
        assert.deepStrictEqual(result, payload);
    });

    test('should throw on top-level malicious operators', () => {
        const payload = {
            username: { $gt: '' },
            password: 'password'
        };
        assert.throws(() => Sanitizer.sanitizeNoSQL(payload), SanitizerError, /NoSQL Injection Detected/);
    });

    test('should throw on deeply nested malicious operators in objects', () => {
        const payload = {
            user: {
                metadata: {
                    query: { $ne: null }
                }
            }
        };
        assert.throws(() => Sanitizer.sanitizeNoSQL(payload), SanitizerError);
    });

    test('should throw on malicious operators inside arrays of objects', () => {
        const payload = {
            filters: [
                { type: 'age', value: 25 },
                { type: 'admin', value: { $exists: true } }
            ]
        };
        assert.throws(() => Sanitizer.sanitizeNoSQL(payload), SanitizerError);
    });

    test('should handle null and undefined safely', () => {
        assert.strictEqual(Sanitizer.sanitizeNoSQL(null), null);
        assert.strictEqual(Sanitizer.sanitizeNoSQL(undefined), undefined);
        assert.strictEqual(Sanitizer.sanitizeNoSQL('string'), 'string');
    });

    test('should integrate securely with Server routing for query parameters', async () => {
        const server = new Server({ nosqlSanitizer: true });
        
        server.register([
            { method: 'GET', path: '/api/data', middlewares: [], handler: async () => ({ ok: true }) }
        ]);
        
        let responseSent = false;
        let statusCode = 200;

        const req = new http.IncomingMessage(new Socket());
        req.method = 'GET';
        req.url = '/api/data?$where=sleep(5000)';
        
        const res = new http.ServerResponse(req);
        res.end = () => { responseSent = true; return res; };
        Object.defineProperty(res, 'statusCode', {
            get: () => statusCode,
            set: (val) => { statusCode = val; }
        });

        // Trigger request manually
        await (server as any).handleRequest(req, res);
        
        assert.strictEqual(statusCode, 400); // Bad request from pre-pipeline sanitization
        assert.strictEqual(responseSent, true);
    });

    test('should integrate securely with Context body() method', async () => {
        const req = new http.IncomingMessage(new Socket());
        const res = new http.ServerResponse(req);
        
        // Mock payload with $ injection
        const rawPayload = JSON.stringify({ email: 'test@example.com', password: { $gt: '' } });
        
        req.headers['content-type'] = 'application/json';
        req.headers['content-length'] = String(rawPayload.length);
        
        // Pass nosqlSanitizer = true as the 6th argument
        const ctx = new Context(req, res, undefined, undefined, undefined, true);
        
        // Push data to stream
        setTimeout(() => {
            req.emit('data', Buffer.from(rawPayload));
            req.emit('end');
        }, 10);

        await assert.rejects(
            async () => {
                await ctx.body();
            },
            (err: any) => {
                assert.strictEqual(err.status, 400);
                assert.strictEqual(err.message, 'Validation failed');
                assert.strictEqual(err.errors[0].message, 'NoSQL Injection Detected');
                return true;
            }
        );
    });

    test('should allow injection if sanitizer is disabled (Server default)', async () => {
        const req = new http.IncomingMessage(new Socket());
        const res = new http.ServerResponse(req);
        
        const rawPayload = JSON.stringify({ email: 'test@example.com', password: { $gt: '' } });
        
        req.headers['content-type'] = 'application/json';
        req.headers['content-length'] = String(rawPayload.length);
        
        // Pass nosqlSanitizer = false
        const ctx = new Context(req, res, undefined, undefined, undefined, false);
        
        setTimeout(() => {
            req.emit('data', Buffer.from(rawPayload));
            req.emit('end');
        }, 10);

        const data = await ctx.body();
        assert.deepStrictEqual(data.password, { $gt: '' }); // Injection gets through
    });
});
