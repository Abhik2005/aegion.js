import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { Server } from '../src/server.js';
import * as http from 'node:http';
import * as events from 'node:events';

// Create a mock server to test internal logic without actually binding a port
class MockServer extends Server {
    public mockRequest(req: http.IncomingMessage, res: http.ServerResponse) {
        // Expose the protected requestHandler
        return this['handleRequest'](req, res);
    }
}

test('Server MUST natively intercept CORS OPTIONS requests before routing', async () => {
    const srv = new MockServer({ 
        cors: { origin: ['https://trusted.com'] } 
    });

    const headers = new Map<string, string>();
    let statusCode = 200;
    let ended = false;

    const req = { 
        method: 'OPTIONS', 
        headers: { origin: 'https://trusted.com' } 
    } as unknown as http.IncomingMessage;
    
    const res = {
        setHeader: (k: string, v: string) => headers.set(k.toLowerCase(), v),
        hasHeader: (k: string) => headers.has(k.toLowerCase()),
        end: () => { ended = true; },
        set statusCode(code: number) { statusCode = code; }
    } as unknown as http.ServerResponse;

    await srv.mockRequest(req, res);

    assert.equal(statusCode, 204);
    assert.equal(ended, true);
    assert.equal(headers.get('access-control-allow-origin'), 'https://trusted.com');
});

test('Server MUST reject malicious CORS Origins', async () => {
    const srv = new MockServer({ 
        cors: { origin: ['https://trusted.com'] } 
    });

    const headers = new Map<string, string>();
    const req = { 
        method: 'GET', 
        headers: { origin: 'https://hacker.com' } 
    } as unknown as http.IncomingMessage;
    
    const res = {
        setHeader: (k: string, v: string) => headers.set(k.toLowerCase(), v),
        hasHeader: (k: string) => headers.has(k.toLowerCase()),
        end: () => {}
    } as unknown as http.ServerResponse;

    await srv.mockRequest(req, res);

    // Should NOT inject Access-Control headers for untrusted origins
    assert.equal(headers.has('access-control-allow-origin'), false);
});

import * as fs from 'node:fs';
import * as path from 'node:path';

test('Server MUST autoload routes from directory', async () => {
    const srv = new Server();
    const testDir = path.resolve(process.cwd(), 'tests_temp_autoload');
    fs.mkdirSync(testDir, { recursive: true });
    
    // Test non-existent dir
    await srv.autoload('non_existent_dir_123'); // Should log warning but not crash

    // Test valid dir with routes.ts
    const subDir = path.join(testDir, 'api');
    fs.mkdirSync(subDir, { recursive: true });
    fs.writeFileSync(path.join(subDir, 'routes.ts'), `
        export default [ { method: 'GET', path: '/test', middlewares: [], handler: async () => {} } ];
    `);
    
    await srv.autoload('tests_temp_autoload');
    const match = (srv as any).router.find('GET', '/test');
    assert.ok(match);

    fs.rmSync(testDir, { recursive: true, force: true });
});

test('Server MUST inject CORS allowedHeaders and maxAge on OPTIONS', async () => {
    const srv = new MockServer({ 
        cors: { origin: '*', maxAge: 86400, allowedHeaders: ['X-Custom'] } 
    });

    const headers = new Map<string, string>();
    const req = { 
        method: 'OPTIONS', 
        headers: { origin: 'https://any.com', 'access-control-request-headers': 'X-Custom' } 
    } as unknown as http.IncomingMessage;
    
    const res = {
        setHeader: (k: string, v: string) => headers.set(k.toLowerCase(), String(v)),
        hasHeader: (k: string) => headers.has(k.toLowerCase()),
        end: () => {}
    } as unknown as http.ServerResponse;

    await srv.mockRequest(req, res);

    assert.equal(headers.get('access-control-max-age'), '86400');
    assert.equal(headers.get('access-control-allow-headers'), 'X-Custom');
});

test('Server MUST block rate-limited requests early', async () => {
    const srv = new MockServer({ rateLimit: { windowMs: 1000, maxRequests: 0 } }); // Block immediately
    let ended = false;
    const req = { 
        method: 'GET', 
        headers: {}, 
        socket: { remoteAddress: '127.0.0.1' } 
    } as unknown as http.IncomingMessage;
    
    const res = {
        setHeader: () => {},
        hasHeader: () => false,
        end: () => { ended = true; }
    } as unknown as http.ServerResponse;

    await srv.mockRequest(req, res);
    assert.equal(ended, true); // RateLimiter should end it
});

test('Server MUST provide start method', async () => {
    const srv = new Server({ port: 0 }); // Random port
    let called = false;
    
    // We mock the listen method to avoid actually binding a port and leaving handles open
    (srv as any).httpServer.listen = (port: number, cb: () => void) => { cb(); return srv; };
    
    srv.start(() => { called = true; });
    assert.equal(called, true);
    
    // Call without callback to test the default console log branch
    srv.start();
});

import { z } from 'zod';

test('Server MUST initialize env parser if options are provided', () => {
    // Create a dummy .env file
    fs.writeFileSync('.env.test2', 'KEY=VAL\nPORT=4000\nCOOKIE_SECRET=super-secret-key-that-is-at-least-32-chars-long!');
    fs.writeFileSync('.env', 'KEY=VAL\nPORT=4000\nCOOKIE_SECRET=super-secret-key-that-is-at-least-32-chars-long!');
    
    const srv = new Server({ 
        env: z.object({ KEY: z.string(), PORT: z.string().transform(Number), COOKIE_SECRET: z.string() }) 
    });
    
    assert.deepEqual(srv.env, { KEY: 'VAL', PORT: 4000, COOKIE_SECRET: 'super-secret-key-that-is-at-least-32-chars-long!' });
    assert.equal((srv as any).port, 4000); // Should fallback to Env PORT
    assert.equal((srv as any).cookieSecret, 'super-secret-key-that-is-at-least-32-chars-long!'); // Should fallback to Env COOKIE_SECRET
    
    try { fs.unlinkSync('.env'); } catch (e) {}
    try { fs.unlinkSync('.env.test2'); } catch (e) {}
});

test('Server MUST handle CORS micro-branches', async () => {
    // 1. origin: '*', methods NOT set, allowedHeaders NOT set, credentials: true
    const srv = new MockServer({ 
        cors: { origin: '*', credentials: true } 
    });

    const headers = new Map<string, string>();
    // Missing origin in request, but config is '*'
    const req1 = { method: 'OPTIONS', headers: { 'access-control-request-headers': 'X-Dynamic' } } as unknown as http.IncomingMessage;
    const res1 = {
        setHeader: (k: string, v: string) => headers.set(k.toLowerCase(), String(v)),
        hasHeader: (k: string) => headers.has(k.toLowerCase()),
        end: () => {}
    } as unknown as http.ServerResponse;

    await srv.mockRequest(req1, res1);
    
    // Wait, if origin is missing from req, but it is OPTIONS, what happens?
    // 118-120: isAllowed = true.
    // 122: `if (isAllowed && origin)` -> false. So it won't set Access-Control-Allow-Origin!
    // But it WILL set Access-Control-Allow-Methods and Access-Control-Allow-Headers!
    assert.equal(headers.get('access-control-allow-methods'), 'GET,HEAD,PUT,PATCH,POST,DELETE');
    assert.equal(headers.get('access-control-allow-headers'), 'X-Dynamic');

    // Now test with origin to hit credentials
    const req2 = { method: 'GET', headers: { origin: 'http://test.com' } } as unknown as http.IncomingMessage;
    await srv.mockRequest(req2, res1);
    assert.equal(headers.get('access-control-allow-origin'), 'http://test.com');
    assert.equal(headers.get('access-control-allow-credentials'), 'true');
    
    // Test exact match origin string
    const srvExact = new MockServer({ cors: { origin: 'http://exact.com' } });
    const req3 = { method: 'GET', headers: { origin: 'http://exact.com' } } as unknown as http.IncomingMessage;
    const headers3 = new Map<string, string>();
    const res3 = { 
        setHeader: (k: string, v: string) => headers3.set(k.toLowerCase(), String(v)), 
        hasHeader: (k: string) => headers3.has(k.toLowerCase()),
        end: () => {} 
    } as any;
    await srvExact.mockRequest(req3, res3);
    assert.equal(headers3.get('access-control-allow-origin'), 'http://exact.com');
});

test('Server MUST parse URL query params when routing', async () => {
    const srv = new MockServer();
    srv.register([{ method: 'GET', path: '/api', middlewares: [], handler: async (c: any) => c.json(c.query) }]);
    
    let jsonBody: any = null;
    const req = { method: 'GET', url: '/api?foo=bar', headers: {} } as unknown as http.IncomingMessage;
    const res = { 
        setHeader: () => {}, 
        hasHeader: () => false,
        end: (data: string) => { jsonBody = JSON.parse(data); } 
    } as unknown as http.ServerResponse;
    
    await srv.mockRequest(req, res);
    assert.deepEqual(jsonBody, { foo: 'bar' });
});

test('Server MUST handle autoload invalid exports and CORS methods', async () => {
    // Autoload invalid exports
    fs.mkdirSync('tests_temp_autoload2/api', { recursive: true });
    fs.writeFileSync('tests_temp_autoload2/api/routes.ts', `export const notDefault = true;`);
    const srv = new Server();
    await srv.autoload('tests_temp_autoload2'); // Should not crash, just ignore
    fs.rmSync('tests_temp_autoload2', { recursive: true, force: true });
    
    // CORS methods defined
    const srvCors = new MockServer({ cors: { origin: '*', methods: ['POST', 'PUT'] } });
    const reqCors = { method: 'OPTIONS', headers: { origin: 'http://a.com' } } as unknown as http.IncomingMessage;
    const headersCors = new Map<string, string>();
    const resCors = { 
        setHeader: (k: string, v: string) => headersCors.set(k.toLowerCase(), String(v)), 
        hasHeader: () => false, 
        end: () => {} 
    } as any;
    await srvCors.mockRequest(reqCors, resCors);
    assert.equal(headersCors.get('access-control-allow-methods'), 'POST, PUT');
});

test('Server MUST allow rate limited requests under threshold and fallback missing method', async () => {
    const srv = new MockServer({ rateLimit: { windowMs: 1000, maxRequests: 5 } });
    srv.register([{ method: 'GET', path: '/', middlewares: [], handler: async (c: any) => c.status(200).json({ ok: true }) }]);
    
    // 1. Missing method fallback to 'GET'
    // 2. Rate limiter allows it through
    const req = { url: '/', headers: {}, socket: { remoteAddress: '127.0.0.1' } } as unknown as http.IncomingMessage;
    let ended = false;
    const res = { 
        setHeader: () => {}, 
        hasHeader: () => false, 
        end: () => { ended = true; } 
    } as any;
    
    await srv.mockRequest(req, res);
    assert.equal(ended, true);
});

test('Server MUST securely store SSR views configuration', () => {
    const srv = new Server({
        views: {
            dir: '/test/views',
            engine: async () => 'mock'
        }
    });
    
    // Ensure the private config is set
    assert.ok((srv as any).viewsConfig);
    assert.equal((srv as any).viewsConfig.dir, '/test/views');
});
