import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import * as http from 'node:http';
import { Socket } from 'node:net';

import { Context } from '../src/context.js';
import { CookieManager } from '../src/cookie.js';
import { BodyParser } from '../src/parser.js';
import { Pipeline } from '../src/pipeline.js';
import { Server } from '../src/server.js';
import { UploadManager } from '../src/upload.js';
import { csp } from '../src/security/csp.js';

test('Context json with undefined', () => {
    let ended = '';
    const req = {} as any;
    const res = { setHeader: () => {}, end: (d: string) => { ended = d; } } as any;
    const ctx = new Context(req, res, 'a-very-secure-32-byte-secret-key-123456');
    ctx.json(undefined);
    assert.equal(ended, '');
});

test('CookieManager handles malformed URI components', () => {
    const req = { headers: { cookie: 'bad=%FF' } } as any;
    const res = { setHeader: () => {} } as any;
    const manager = new CookieManager(req, res);
    assert.equal(manager.get('bad'), '%FF');
});

test('BodyParser returns cached body', async () => {
    const req = new http.IncomingMessage(new Socket());
    req.headers['content-length'] = '4';
    setTimeout(() => { req.push(Buffer.from('test')); req.push(null); }, 10);
    
    const first = await BodyParser.parseRawBody(req);
    const second = await BodyParser.parseRawBody(req); // This hits lines 17-18
    assert.equal(first, 'test');
    assert.equal(second, 'test');
});

test('Pipeline handler returning null ends response', async () => {
    let ended = false;
    const req = { headers: {} } as any;
    const res = { statusCode: 200, end: () => { ended = true; } } as any;
    const ctx = { req, res, isFinished: false } as any;
    await Pipeline.execute(ctx, [], async () => null);
    assert.equal(ended, true);
});

test('Server handleRequest catches sync errors and handles headersSent correctly', async () => {
    const srv = new Server({ port: 0 });
    
    // Path 1: headersSent = false
    let statusCode = 0;
    const req1 = { url: '/', method: 'GET', headers: {} } as any;
    let throwCount = 0;
    const res1 = { 
        setHeader: () => { 
            if (throwCount++ === 0) throw new Error('Mock error'); 
        },
        end: () => {},
        headersSent: false,
        set statusCode(code: number) { statusCode = code; }
    } as any;
    await (srv as any).handleRequest(req1, res1);
    assert.equal(statusCode, 500);

    // Path 2: headersSent = true
    let destroyed = false;
    const res2 = { 
        setHeader: () => { throw new Error('Mock error 2'); },
        end: () => {},
        destroy: () => { destroyed = true; },
        headersSent: true
    } as any;
    await (srv as any).handleRequest(req1, res2);
    assert.equal(destroyed, true);
});

test('Server start error listener handles EACCES and others', () => {
    const srv = new Server({ port: 0 });
    srv.start();
    const httpServer = (srv as any).httpServer;
    
    // We suppress console.error for the test
    const originalConsoleError = console.error;
    console.error = () => {};
    
    // Simulate EACCES
    const errEacces = new Error('EACCES') as NodeJS.ErrnoException;
    errEacces.code = 'EACCES';
    httpServer.emit('error', errEacces);
    
    // Simulate EADDRINUSE
    const errEaddrinuse = new Error('EADDRINUSE') as NodeJS.ErrnoException;
    errEaddrinuse.code = 'EADDRINUSE';
    httpServer.emit('error', errEaddrinuse);
    
    // Simulate other error
    const errOther = new Error('Other') as NodeJS.ErrnoException;
    errOther.code = 'OTHER';
    httpServer.emit('error', errOther);
    
    console.error = originalConsoleError;
    httpServer.close();
});

test('UploadManager filesLimit', async () => {
    // A multipart stream with 2 files
    const boundary = '--------------------------974767299852498929531610575';
    let body = `--${boundary}\r\n`;
    body += 'Content-Disposition: form-data; name="file1"; filename="a.txt"\r\n';
    body += 'Content-Type: text/plain\r\n\r\n';
    body += 'Hello\r\n';
    body += `--${boundary}\r\n`;
    body += 'Content-Disposition: form-data; name="file2"; filename="b.txt"\r\n';
    body += 'Content-Type: text/plain\r\n\r\n';
    body += 'World\r\n';
    body += `--${boundary}--\r\n`;

    const req = new http.IncomingMessage(new Socket());
    req.headers = {
        'content-type': `multipart/form-data; boundary=${boundary}`,
        'content-length': String(Buffer.byteLength(body))
    };

    // Push data in chunks
    setTimeout(() => {
        req.push(Buffer.from(body));
        req.push(null);
    }, 10);

    try {
        await UploadManager.parse(req, { limits: { files: 1 } });
        assert.fail('Should reject');
    } catch (err: any) {
        assert.match(err.message, /Too many files/);
    }
});

test('UploadManager partsLimit', async () => {
    const boundary = '--------------------------1234567890';
    let body = `--${boundary}\r\nContent-Disposition: form-data; name="field1"\r\n\r\nHello\r\n`;
    body += `--${boundary}\r\nContent-Disposition: form-data; name="field2"\r\n\r\nWorld\r\n`;
    body += `--${boundary}--\r\n`;

    const req = new http.IncomingMessage(new Socket());
    req.headers = {
        'content-type': `multipart/form-data; boundary=${boundary}`,
        'content-length': String(Buffer.byteLength(body))
    };
    setTimeout(() => { req.push(Buffer.from(body)); req.push(null); }, 10);

    try {
        await UploadManager.parse(req, { limits: { parts: 1 } } as any);
        assert.fail('Should reject');
    } catch (err: any) {
        assert.match(err.message, /Too many parts/);
    }
});

test('UploadManager fileSize limit triggers isTruncated branch', async () => {
    const boundary = '--------------------------1234567890';
    let body = `--${boundary}\r\nContent-Disposition: form-data; name="field1"; filename="huge.txt"\r\n\r\nHello World`;
    
    // Generate a massive string so it hits the limit while still pushing
    const chunk = Buffer.alloc(100, 'A');

    const req = new http.IncomingMessage(new Socket());
    // We intentionally don't set length to allow chunking
    req.headers = {
        'content-type': `multipart/form-data; boundary=${boundary}`
    };
    
    // Simulate streaming
    setTimeout(() => {
        req.push(Buffer.from(body));
        // Push 100 bytes, limit is 50. It will emit limit.
        req.push(chunk);
        // We push the end of the stream manually after a small delay to simulate continued streaming
        // so that the file stream emits 'end' event after 'limit' is hit.
        setTimeout(() => {
            req.push(Buffer.from(`\r\n--${boundary}--\r\n`));
            req.push(null);
        }, 10);
    }, 10);

    try {
        await UploadManager.parse(req, { limits: { fileSize: 50 } } as any);
        assert.fail('Should reject');
    } catch (err: any) {
        assert.match(err.message, /exceeds size limit/);
        // Wait a tick for the stream to fully process and emit 'end' on the file
        await new Promise(r => setTimeout(r, 20));
    }
});

test('csp uses nonce with defaultSrc missing', async () => {
    let header = '';
    const req = {} as any;
    const res = { setHeader: (k: string, v: string) => { header = v; } } as any;
    const ctx = { req, res, locals: {}, next: () => {} } as any;
    
    // This hits line 134 false branch
    const middleware = csp({ useNonce: true });
    await middleware(ctx);
    assert.match(header, /script-src 'self' 'nonce-/);
});

test('csp uses nonce with defaultSrc provided', async () => {
    let header = '';
    const req = {} as any;
    const res = { setHeader: (k: string, v: string) => { header = v; } } as any;
    const ctx = { req, res, locals: {}, next: () => {} } as any;
    
    // This hits line 134 true branch
    const middleware = csp({ useNonce: true, directives: { defaultSrc: ["'none'"] } });
    await middleware(ctx);
    assert.match(header, /default-src 'none'/);
    assert.match(header, /script-src 'none' 'nonce-/);
});
