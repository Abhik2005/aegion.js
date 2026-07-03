import { test, describe, before, after } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as http from 'node:http';
import { Socket } from 'node:net';
import { serveStatic, getMimeType, generateETag } from '../src/static.js';
import { Context, CONTINUE_PIPELINE } from '../src/context.js';

// --- Test Fixture Setup ---
const TEST_DIR = path.resolve('./tests_temp_static');

function createMockReqRes(url: string, headers: Record<string, string> = {}): { req: http.IncomingMessage; res: http.ServerResponse } {
    const req = new http.IncomingMessage(new Socket());
    req.method = 'GET';
    req.url = url;
    req.headers = headers;
    const res = new http.ServerResponse(req);
    return { req, res };
}

function createCtx(url: string, headers: Record<string, string> = {}): Context {
    const { req, res } = createMockReqRes(url, headers);
    return new Context(req, res);
}

function waitForResponse(res: http.ServerResponse): Promise<{ statusCode: number; headers: http.OutgoingHttpHeaders; body: string }> {
    return new Promise((resolve) => {
        let body = '';
        const chunks: Buffer[] = [];
        const originalWrite = res.write.bind(res);
        const originalEnd = res.end.bind(res);

        (res as any).write = (chunk: any, ...args: any[]) => {
            if (Buffer.isBuffer(chunk)) chunks.push(chunk);
            else if (typeof chunk === 'string') chunks.push(Buffer.from(chunk));
            return originalWrite(chunk, ...args);
        };

        (res as any).end = (chunk?: any, ...args: any[]) => {
            if (chunk) {
                if (Buffer.isBuffer(chunk)) chunks.push(chunk);
                else if (typeof chunk === 'string') chunks.push(Buffer.from(chunk));
            }
            body = Buffer.concat(chunks).toString();
            resolve({ statusCode: res.statusCode, headers: res.getHeaders(), body });
            // Don't call originalEnd to avoid socket errors in tests
        };
    });
}

before(() => {
    // Create test directory structure
    fs.mkdirSync(TEST_DIR, { recursive: true });
    fs.mkdirSync(path.join(TEST_DIR, 'subdir'), { recursive: true });
    fs.mkdirSync(path.join(TEST_DIR, 'emptydir'), { recursive: true });

    fs.writeFileSync(path.join(TEST_DIR, 'index.html'), '<h1>Hello Aegion</h1>');
    fs.writeFileSync(path.join(TEST_DIR, 'style.css'), 'body { color: red; }');
    fs.writeFileSync(path.join(TEST_DIR, 'app.js'), 'console.log("aegion");');
    fs.writeFileSync(path.join(TEST_DIR, 'data.json'), '{"name":"aegion"}');
    fs.writeFileSync(path.join(TEST_DIR, 'image.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47])); // PNG magic bytes
    fs.writeFileSync(path.join(TEST_DIR, 'font.woff2'), Buffer.from([0x00]));
    fs.writeFileSync(path.join(TEST_DIR, 'unknown.xyz'), 'some binary');
    fs.writeFileSync(path.join(TEST_DIR, '.env'), 'SECRET=hunter2');
    fs.writeFileSync(path.join(TEST_DIR, 'subdir', 'index.html'), '<h2>Subdir Index</h2>');
    fs.writeFileSync(path.join(TEST_DIR, 'subdir', 'data.txt'), 'hello subdir');
});

after(() => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

// --- Helper: Invoke the static handler ---
async function invoke(url: string, opts?: any, headers: Record<string, string> = {}) {
    const routes = serveStatic('/static', TEST_DIR, opts);
    const handler = routes[0].handler;
    const ctx = createCtx(url, headers);
    const responsePromise = waitForResponse(ctx.res);
    await handler(ctx);
    return responsePromise;
}

describe('Static File Server — MIME Type Resolution', () => {
    test('getMimeType returns correct type for known extensions', () => {
        assert.strictEqual(getMimeType('file.html'), 'text/html; charset=utf-8');
        assert.strictEqual(getMimeType('file.htm'), 'text/html; charset=utf-8');
        assert.strictEqual(getMimeType('file.css'), 'text/css; charset=utf-8');
        assert.strictEqual(getMimeType('file.js'), 'application/javascript');
        assert.strictEqual(getMimeType('file.mjs'), 'application/javascript');
        assert.strictEqual(getMimeType('file.json'), 'application/json');
        assert.strictEqual(getMimeType('file.txt'), 'text/plain; charset=utf-8');
        assert.strictEqual(getMimeType('file.xml'), 'application/xml');
        assert.strictEqual(getMimeType('file.svg'), 'image/svg+xml');
        assert.strictEqual(getMimeType('file.png'), 'image/png');
        assert.strictEqual(getMimeType('file.jpg'), 'image/jpeg');
        assert.strictEqual(getMimeType('file.jpeg'), 'image/jpeg');
        assert.strictEqual(getMimeType('file.gif'), 'image/gif');
        assert.strictEqual(getMimeType('file.webp'), 'image/webp');
        assert.strictEqual(getMimeType('file.ico'), 'image/x-icon');
        assert.strictEqual(getMimeType('file.woff'), 'font/woff');
        assert.strictEqual(getMimeType('file.woff2'), 'font/woff2');
        assert.strictEqual(getMimeType('file.ttf'), 'font/ttf');
        assert.strictEqual(getMimeType('file.pdf'), 'application/pdf');
        assert.strictEqual(getMimeType('file.mp4'), 'video/mp4');
        assert.strictEqual(getMimeType('file.webm'), 'video/webm');
    });

    test('getMimeType falls back to octet-stream for unknown extensions', () => {
        assert.strictEqual(getMimeType('file.xyz'), 'application/octet-stream');
        assert.strictEqual(getMimeType('file.bin'), 'application/octet-stream');
        assert.strictEqual(getMimeType('noextension'), 'application/octet-stream');
    });
});

describe('Static File Server — ETag Generation', () => {
    test('generateETag produces a deterministic weak ETag', () => {
        const mtime = new Date('2024-01-01T00:00:00Z');
        const tag1 = generateETag(mtime, 1024);
        const tag2 = generateETag(mtime, 1024);
        assert.strictEqual(tag1, tag2);
        assert.ok(tag1.startsWith('W/"'));
        assert.ok(tag1.endsWith('"'));
    });

    test('generateETag produces different ETags for different files', () => {
        const mtime = new Date('2024-01-01T00:00:00Z');
        const tag1 = generateETag(mtime, 1024);
        const tag2 = generateETag(mtime, 2048);
        assert.notStrictEqual(tag1, tag2);
    });
});

describe('Static File Server — Core Serving', () => {
    test('serves a valid HTML file with correct headers', async () => {
        const result = await invoke('/static/index.html');
        assert.strictEqual(result.statusCode, 200);
        assert.ok((result.headers['content-type'] as string).includes('text/html'));
        assert.ok(result.body.includes('Hello Aegion'));
        assert.ok(result.headers['etag']);
        assert.ok(result.headers['last-modified']);
        assert.ok((result.headers['cache-control'] as string).includes('max-age=86400'));
    });

    test('serves a CSS file with correct MIME type', async () => {
        const result = await invoke('/static/style.css');
        assert.strictEqual(result.statusCode, 200);
        assert.ok((result.headers['content-type'] as string).includes('text/css'));
        assert.ok(result.body.includes('color: red'));
    });

    test('serves a JS file with correct MIME type', async () => {
        const result = await invoke('/static/app.js');
        assert.strictEqual(result.statusCode, 200);
        assert.ok((result.headers['content-type'] as string).includes('application/javascript'));
    });

    test('serves a PNG file with correct MIME type', async () => {
        const result = await invoke('/static/image.png');
        assert.strictEqual(result.statusCode, 200);
        assert.strictEqual(result.headers['content-type'], 'image/png');
    });

    test('serves a woff2 font with correct MIME type', async () => {
        const result = await invoke('/static/font.woff2');
        assert.strictEqual(result.statusCode, 200);
        assert.strictEqual(result.headers['content-type'], 'font/woff2');
    });

    test('serves unknown extension as application/octet-stream', async () => {
        const result = await invoke('/static/unknown.xyz');
        assert.strictEqual(result.statusCode, 200);
        assert.strictEqual(result.headers['content-type'], 'application/octet-stream');
    });

    test('serves index.html when a directory is requested', async () => {
        const result = await invoke('/static/');
        assert.strictEqual(result.statusCode, 200);
        assert.ok((result.headers['content-type'] as string).includes('text/html'));
        assert.ok(result.body.includes('Hello Aegion'));
    });

    test('serves index.html from a subdirectory', async () => {
        const result = await invoke('/static/subdir/');
        assert.strictEqual(result.statusCode, 200);
        assert.ok(result.body.includes('Subdir Index'));
    });

    test('serves a file from a subdirectory', async () => {
        const result = await invoke('/static/subdir/data.txt');
        assert.strictEqual(result.statusCode, 200);
        assert.ok((result.headers['content-type'] as string).includes('text/plain'));
        assert.ok(result.body.includes('hello subdir'));
    });

    test('respects custom maxAge option in Cache-Control', async () => {
        const result = await invoke('/static/index.html', { maxAge: 3600 });
        assert.ok((result.headers['cache-control'] as string).includes('max-age=3600'));
    });

    test('respects custom index file option', async () => {
        // Write a custom-named index file
        fs.writeFileSync(path.join(TEST_DIR, 'main.html'), '<h1>Custom Index</h1>');
        const result = await invoke('/static/', { index: 'main.html' });
        assert.strictEqual(result.statusCode, 200);
        assert.ok(result.body.includes('Custom Index'));
        fs.rmSync(path.join(TEST_DIR, 'main.html'));
    });
});

describe('Static File Server — Caching (304 Not Modified)', () => {
    test('returns 304 when client sends matching ETag', async () => {
        // First request: get the ETag
        const first = await invoke('/static/index.html');
        const etag = first.headers['etag'] as string;
        assert.ok(etag);

        // Second request: send ETag back
        const second = await invoke('/static/index.html', {}, { 'if-none-match': etag });
        assert.strictEqual(second.statusCode, 304);
        assert.strictEqual(second.body, '');
    });

    test('returns 200 when client sends a stale/wrong ETag', async () => {
        const result = await invoke('/static/index.html', {}, { 'if-none-match': 'W/"stalevalue"' });
        assert.strictEqual(result.statusCode, 200);
    });
});

describe('Static File Server — Security', () => {
    test('returns 403 for directory traversal attack (../)', async () => {
        const result = await invoke('/static/../package.json');
        assert.strictEqual(result.statusCode, 403);
    });

    test('returns 403 for deeply nested directory traversal', async () => {
        const result = await invoke('/static/subdir/../../package.json');
        assert.strictEqual(result.statusCode, 403);
    });

    test('returns 403 for dotfiles by default', async () => {
        const result = await invoke('/static/.env');
        assert.strictEqual(result.statusCode, 403);
    });

    test('returns 404 for dotfiles when dotfiles is "ignore"', async () => {
        const result = await invoke('/static/.env', { dotfiles: 'ignore' });
        assert.strictEqual(result.statusCode, 404);
    });

    test('serves dotfiles when dotfiles is "allow"', async () => {
        const result = await invoke('/static/.env', { dotfiles: 'allow' });
        assert.strictEqual(result.statusCode, 200);
        assert.ok(result.body.includes('SECRET=hunter2'));
    });

    test('returns 403 for dotfile hidden in subdirectory', async () => {
        fs.writeFileSync(path.join(TEST_DIR, 'subdir', '.secret'), 'hidden');
        const result = await invoke('/static/subdir/.secret');
        assert.strictEqual(result.statusCode, 403);
        fs.rmSync(path.join(TEST_DIR, 'subdir', '.secret'));
    });

    test('returns 403 for empty directory without index.html', async () => {
        const result = await invoke('/static/emptydir/');
        assert.strictEqual(result.statusCode, 403);
    });
});

describe('Static File Server — 404 Handling', () => {
    test('returns 404 for a file that does not exist', async () => {
        const result = await invoke('/static/nonexistent.html');
        assert.strictEqual(result.statusCode, 404);
        const body = JSON.parse(result.body);
        assert.strictEqual(body.error, 'Not Found');
    });
});

describe('Static File Server — Route Registration', () => {
    test('serveStatic returns a RouteGroup with one wildcard GET route', () => {
        const routes = serveStatic('/assets', './static');
        assert.strictEqual(routes.length, 1);
        assert.strictEqual(routes[0].method, 'GET');
        assert.strictEqual(routes[0].path, '/assets/*');
        assert.deepStrictEqual(routes[0].middlewares, []);
    });

    test('serveStatic strips trailing slash from mountPath', () => {
        const routes = serveStatic('/assets/', './static');
        assert.strictEqual(routes[0].path, '/assets/*');
    });
});
