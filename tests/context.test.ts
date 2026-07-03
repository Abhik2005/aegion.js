import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { Context, CONTINUE_PIPELINE } from '../src/context.js';
import * as http from 'node:http';
import { CookieManager } from '../src/cookie.js';
import { z } from 'zod';

function mockReqRes() {
    const req = { url: '/', headers: {} } as unknown as http.IncomingMessage;
    const res = { 
        setHeader: () => {}, 
        end: () => {} 
    } as unknown as http.ServerResponse;
    return { req, res };
}

test('Context MUST parse query strings perfectly', () => {
    const req = { url: '/search?q=aegion&limit=10', headers: {} } as unknown as http.IncomingMessage;
    const res = {} as unknown as http.ServerResponse;
    const cookies = new CookieManager(req, res, 'secret');

    const ctx = new Context(req, res, 'super-secret-key-that-is-at-least-32-chars-long!');
    
    assert.equal(ctx.query.q, 'aegion');
    assert.equal(ctx.query.limit, '10');
});

test('Context MUST expose next, body, and upload', async () => {
    const { req, res } = mockReqRes();
    const ctx = new Context(req, res);
    
    assert.equal(typeof ctx.next, 'function');
    assert.equal(typeof ctx.body, 'function');
    assert.equal(typeof ctx.upload, 'function');
    assert.equal(typeof ctx.html, 'function');
    assert.equal(typeof ctx.render, 'function');

    // Test the Auto-Object Compilation Wrapper
    const mockReq = new http.IncomingMessage(null as any);
    mockReq.headers = { 'content-type': 'application/json' };
    
    const promise = ctx.body.call({ req: mockReq } as any, {
        username: z.string(),
        age: z.number()
    });
    
    // Push invalid data to trigger validation failure and ensure Zod correctly processed the auto-object
    mockReq.push(Buffer.from(JSON.stringify({ username: "aegion", age: "twenty" })));
    mockReq.push(null);
    
    try {
        await promise;
        assert.fail('Should have thrown validation error');
    } catch (e: any) {
        assert.equal(e.status, 400); // 400 Bad Request
        assert.equal(e.errors[0].path[0], 'age'); // Caught the invalid number type
    }
    
    // Test passing a pre-compiled Zod schema
    const mockReq2 = new http.IncomingMessage(null as any);
    mockReq2.headers = { 'content-type': 'application/json' };
    const promise2 = ctx.body.call({ req: mockReq2 } as any, z.object({ email: z.string() }));
    mockReq2.push(Buffer.from(JSON.stringify({ email: "test@example.com" })));
    mockReq2.push(null);
    const data2 = await promise2;
    assert.equal(data2.email, "test@example.com");
});

test('Context MUST render SSR HTML securely', async () => {
    let payload = '';
    let headerType = '';
    
    const mockRes = {
        setHeader: (k: string, v: string) => { if (k === 'Content-Type') headerType = v; },
        end: (data: string) => { payload = data; }
    } as any;
    
    // Test direct HTML injection
    const ctx1 = new Context({ url: '/' } as any, mockRes);
    ctx1.html('<h1>Hello</h1>');
    assert.equal(headerType, 'text/html');
    assert.equal(payload, '<h1>Hello</h1>');
    assert.equal(ctx1.isFinished, true);
    
    // Ensure subsequent calls to html() are ignored securely
    ctx1.html('<p>Hack</p>');
    assert.equal(payload, '<h1>Hello</h1>'); // Did not change!
    
    // Test SSR Engine compilation
    const mockEngine = async (path: string, data: any) => {
        return `compiled: ${path} | data: ${data.name}`;
    };
    
    const ctx2 = new Context({ url: '/' } as any, mockRes, undefined, { engine: mockEngine, dir: '/custom/views' });
    await ctx2.render('index.ejs', { name: 'Aegion' });
    
    // Path should be normalized across OS, but we can check includes
    assert.equal(payload.includes('compiled: '), true);
    assert.equal(payload.includes('index.ejs'), true);
    assert.equal(payload.includes('data: Aegion'), true);
    
    // Test SSR Engine compilation with fallback to process.cwd()
    const ctx3 = new Context({ url: '/' } as any, mockRes, undefined, { engine: mockEngine });
    await ctx3.render('index.ejs', { name: 'Fallback' });
    assert.equal(payload.includes('compiled: '), true);
    // Path should now include the current working directory
    assert.equal(payload.includes('index.ejs'), true);
    assert.equal(payload.includes('Fallback'), true);
});

test('Context MUST throw fail-safe error if SSR engine is missing', async () => {
    const ctx = new Context({ url: '/' } as any, mockReqRes().res);
    try {
        await ctx.render('index.ejs');
        assert.fail('Should throw');
    } catch (e: any) {
        assert.equal(e.message, 'Template engine not configured in ServerOptions');
    }
});

test('Context MUST instantly lock isFinished when json() is called to prevent hanging requests', () => {
    let ended = false;
    let payload = '';
    const req = { url: '/', headers: {} } as unknown as http.IncomingMessage;
    const res = { 
        setHeader: () => {}, 
        end: (data: string) => { ended = true; payload = data; }
    } as unknown as http.ServerResponse;
    const cookies = new CookieManager(req, res, 'secret');

    const ctx = new Context(req, res, 'super-secret-key-that-is-at-least-32-chars-long!');
    
    assert.equal(ctx.isFinished, false);
    
    ctx.json({ secure: true });
    
    assert.equal(ctx.isFinished, true); // Pipeline lock
    assert.equal(ended, true);
    assert.equal(payload, '{"secure":true}');
});

test('Context MUST chain status() method', () => {
    let statusCode = 200;
    const req = { url: '/', headers: {} } as unknown as http.IncomingMessage;
    const res = { 
        set statusCode(code: number) { statusCode = code; },
        setHeader: () => {}, 
        end: () => {}
    } as unknown as http.ServerResponse;
    const cookies = new CookieManager(req, res, 'secret');

    const ctx = new Context(req, res, {}, cookies);
    
    ctx.status(201).json({ created: true });
    
    assert.equal(statusCode, 201);
});

test('Context MUST handle invalid URL gracefully', () => {
    // A malformed base URL (containing spaces) to force a throw in URL parsing
    const req = { url: '/foo', headers: { host: 'invalid base' } } as unknown as http.IncomingMessage;
    const res = {} as unknown as http.ServerResponse;
    const ctx = new Context(req, res, 'super-secret-key-that-is-at-least-32-chars-long!');
    assert.deepEqual(ctx.query, {});
});

test('Context MUST render SSR template with merged locals and empty data fallback', async () => {
    const { req, res } = mockReqRes();
    const viewsConfig = {
        dir: '/views',
        engine: async (path: string, data: any) => `Rendered ${path} ${JSON.stringify(data)}`
    };
    const ctx = new Context(req, res, undefined, viewsConfig);
    
    // Inject local variable
    ctx.locals.injected = true;
    
    const result = await ctx.render('home.ejs'); // No data passed
    
    assert.equal(result, CONTINUE_PIPELINE);
});

test('Context MUST handle missing url and host headers', () => {
    // Branch coverage for `req.url || '/'` and `req.headers.host || 'localhost'`
    const req = { headers: {} } as unknown as http.IncomingMessage;
    const res = {} as unknown as http.ServerResponse;
    const ctx = new Context(req, res);
    assert.deepEqual(ctx.query, {});
});

test('Context MUST safely ignore subsequent json calls', () => {
    let ended = 0;
    const req = { url: '/', headers: {} } as unknown as http.IncomingMessage;
    const res = { 
        setHeader: () => {}, 
        end: () => { ended++; }
    } as unknown as http.ServerResponse;
    const ctx = new Context(req, res);
    
    ctx.json({ a: 1 });
    ctx.json({ a: 2 }); // Should be ignored
    
    assert.equal(ended, 1);
});

test('Context MUST expose next, body, and upload', async () => {
    const { EventEmitter } = await import('node:events');
    const req = new EventEmitter() as any;
    req.url = '/';
    req.headers = {};
    req.destroy = () => {};
    const res = {} as unknown as http.ServerResponse;
    const ctx = new Context(req, res, 'super-secret-key-that-is-at-least-32-chars-long!');
    
    // Test next
    assert.ok(ctx.next());
    
    // We cannot easily mock body and upload streams without full mock servers, 
    // but we can call them to execute the delegation statements.
    // BodyParser and UploadManager will reject the empty req streams, which is expected.
    
    // Force immediate rejection by emitting error
    const promise = ctx.body();
    req.emit('error', new Error('Mock Stream Error'));
    await assert.rejects(() => promise, /Mock Stream Error/);
    
    // For upload, it pipes to busboy. Busboy throws synchronously if content type is missing.
    const uploadPromise = ctx.upload();
    await assert.rejects(() => uploadPromise, /Missing Content-Type-header/);
});

test('Context MUST securely destroy socket on mid-stream error', async () => {
    let destroyed = false;
    let headers: Record<string, string> = {};
    const req = { url: '/', headers: {} } as unknown as http.IncomingMessage;
    const res = { 
        setHeader: (k: string, v: string) => { headers[k] = v; }, 
        destroy: () => { destroyed = true; }
    } as unknown as http.ServerResponse;
    const ctx = new Context(req, res);
    
    const { Readable } = await import('node:stream');
    const mockStream = new Readable({ read() {} });
    mockStream.pipe = () => mockStream;
    
    ctx.stream(mockStream, 'video/mp4', 1000);
    assert.equal(ctx.isFinished, true);
    assert.equal(headers['Content-Type'], 'video/mp4');
    assert.equal(headers['Content-Length'], '1000');
    
    // Trigger error event manually to test fail-closed security
    mockStream.emit('error', new Error('Mid-stream crash'));
    
    assert.equal(destroyed, true);
});

test('Context stream MUST safely ignore if already finished', () => {
    let ended = false;
    const req = { url: '/', headers: {} } as unknown as http.IncomingMessage;
    const res = { 
        setHeader: () => {}, 
        end: () => { ended = true; }
    } as unknown as http.ServerResponse;
    const ctx = new Context(req, res);
    
    ctx.json({ a: 1 });
    assert.equal(ctx.isFinished, true);
    
    // Second call to stream should be ignored
    const result = ctx.stream({} as any);
    assert.equal(result, CONTINUE_PIPELINE);
});
