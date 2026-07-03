import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import * as crypto from 'node:crypto';
import { generateSecret, createToken, verifyToken, csrf } from '../src/security/csrf.js';
import { Context, CONTINUE_PIPELINE } from '../src/context.js';
import * as http from 'node:http';
import { Socket } from 'node:net';

function createMockContext(method: string = 'GET', headers: any = {}, body: any = null, bodyError?: Error): Context {
    const req = new http.IncomingMessage(new Socket());
    req.method = method;
    req.headers = headers;
    const res = new http.ServerResponse(req);
    const ctx = new Context(req, res, 'a_very_secure_secret_key_that_is_at_least_32_characters_long_for_iron_test_key');
    
    ctx.body = async () => {
        if (bodyError) throw bodyError;
        return body;
    };
    
    ctx.html = (htmlStr: string) => {
        ctx.res.setHeader('Content-Type', 'text/html');
        ctx.res.end(htmlStr);
        return CONTINUE_PIPELINE;
    };
    
    return ctx;
}

test('CSRF Secret Generation is mathematically secure', () => {
    const secret = generateSecret();
    assert.equal(secret.length, 32);
});

test('BREACH Attack Mitigation: XOR-Masking generates unique tokens', () => {
    const secret = generateSecret();
    const token1 = createToken(secret);
    const token2 = createToken(secret);
    
    assert.notEqual(token1, token2);
    assert.equal(verifyToken(token1, secret), true);
    assert.equal(verifyToken(token2, secret), true);
});

test('Forged Token Attack is blocked', () => {
    const realSecret = generateSecret();
    const fakeSecret = generateSecret();
    const hackerToken = createToken(fakeSecret);
    assert.equal(verifyToken(hackerToken, realSecret), false);
});

test('Tampered Token Attack is blocked', () => {
    const secret = generateSecret();
    const token = createToken(secret);
    
    assert.equal(verifyToken(token + 'a', secret), false);
    assert.equal(verifyToken(token.substring(0, token.length - 1), secret), false);
    assert.equal(verifyToken('invalid.format.token', secret), false);
    assert.equal(verifyToken('malformed', secret), false);
    assert.equal(verifyToken(null as any, secret), false);
    
    // Trigger catch block via mathematically invalid secret length or null
    assert.equal(verifyToken(token, null as any), false);
});

test('Middleware: GET request passes and injects token', async () => {
    const ctx = createMockContext('GET');
    const middleware = csrf();
    await middleware(ctx);
    assert.ok(ctx.locals.csrfToken);
    assert.ok((ctx.cookie as any).outgoingCookies.length > 0);
});

test('Middleware: POST request without token is 403 Forbidden', async () => {
    const ctx = createMockContext('POST');
    const middleware = csrf();
    await middleware(ctx);
    assert.equal(ctx.res.statusCode, 403);
});

test('Middleware: POST request ignores body parsing error securely', async () => {
    const ctx = createMockContext('POST', {}, null, new Error('Malformed JSON'));
    const middleware = csrf();
    await middleware(ctx);
    assert.equal(ctx.res.statusCode, 403);
});

test('Middleware: Cross-Origin Attack with Header is blocked if invalid', async () => {
    const ctx = createMockContext('POST', { 'x-csrf-token': 'badtoken' });
    const middleware = csrf();
    await middleware(ctx);
    assert.equal(ctx.res.statusCode, 403);
});

test('Middleware: POST request with VALID token in Header passes', async () => {
    const ctxGet = createMockContext('GET');
    const middleware = csrf();
    await middleware(ctxGet);
    const token = ctxGet.locals.csrfToken;
    const cookieHeader = (ctxGet.cookie as any).outgoingCookies[0].split(';')[0];
    
    const ctxPost = createMockContext('POST', { 
        'x-csrf-token': token,
        'cookie': cookieHeader
    });
    
    const result = await middleware(ctxPost);
    assert.equal(ctxPost.res.statusCode, 200);
    assert.equal(result, CONTINUE_PIPELINE);
});

test('Middleware: POST request with VALID token in Body passes', async () => {
    const ctxGet = createMockContext('GET');
    const middleware = csrf();
    await middleware(ctxGet);
    const token = ctxGet.locals.csrfToken;
    const cookieHeader = (ctxGet.cookie as any).outgoingCookies[0].split(';')[0];
    
    const ctxPost = createMockContext('POST', { cookie: cookieHeader }, { _csrf: token });
    
    const result = await middleware(ctxPost);
    assert.equal(ctxPost.res.statusCode, 200);
    assert.equal(result, CONTINUE_PIPELINE);
});

test('Enterprise: Ignore routes as exact string', async () => {
    const ctx = createMockContext('POST');
    ctx.req.url = '/webhook/stripe?query=123';
    const middleware = csrf({ ignore: ['/webhook/stripe'] });
    const result = await middleware(ctx);
    assert.equal(result, CONTINUE_PIPELINE);
});

test('Enterprise: Ignore routes as Regex', async () => {
    const ctx = createMockContext('POST');
    ctx.req.url = '/api/public/data';
    const middleware = csrf({ ignore: [/^\/api\/public\/.*/] });
    const result = await middleware(ctx);
    assert.equal(result, CONTINUE_PIPELINE);
});

test('Enterprise: Custom Token Extractor', async () => {
    const ctxGet = createMockContext('GET');
    const middleware = csrf({ extractor: (ctx) => (ctx.req.headers as any)['custom-token'] });
    await middleware(ctxGet);
    const token = ctxGet.locals.csrfToken;
    const cookieHeader = (ctxGet.cookie as any).outgoingCookies[0].split(';')[0];
    
    const ctxPost = createMockContext('POST', { 
        'custom-token': token,
        'cookie': cookieHeader
    });
    
    const result = await middleware(ctxPost);
    assert.equal(ctxPost.res.statusCode, 200);
    assert.equal(result, CONTINUE_PIPELINE);
});

test('Enterprise: Custom Error Handler', async () => {
    const ctx = createMockContext('POST');
    const middleware = csrf({
        errorHandler: (ctx) => {
            ctx.status(401);
            return Symbol.for('CUSTOM_ERROR');
        }
    });
    const result = await middleware(ctx);
    assert.equal(ctx.res.statusCode, 401);
    assert.equal(result, Symbol.for('CUSTOM_ERROR'));
});

test('Enterprise: Stateful Session Adapter (Synchronizer Pattern)', async () => {
    // Mock Redis store
    const store = new Map<string, string>();
    
    const sessionAdapter = {
        getSecret: async (ctx: Context) => store.get('mock_session_id') || null,
        setSecret: async (ctx: Context, secret: string) => {
            store.set('mock_session_id', secret);
        }
    };
    
    const middleware = csrf({ session: sessionAdapter });
    
    // 1. GET request should save secret in store, NOT cookie
    const ctxGet = createMockContext('GET');
    await middleware(ctxGet);
    const token = ctxGet.locals.csrfToken;
    assert.ok(store.has('mock_session_id'));
    assert.equal((ctxGet.cookie as any).outgoingCookies.length, 0); // No __Host cookie
    
    // 2. POST request should validate using store
    const ctxPost = createMockContext('POST', { 'x-csrf-token': token });
    const result = await middleware(ctxPost);
    assert.equal(ctxPost.res.statusCode, 200);
    assert.equal(result, CONTINUE_PIPELINE);
});

test('Enterprise: Custom Cookie Options', async () => {
    const middleware = csrf({
        cookie: {
            key: 'custom-csrf',
            sameSite: 'Lax',
            secure: false,
            httpOnly: false,
            path: '/api'
        }
    });
    const ctx = createMockContext('GET');
    await middleware(ctx);
    
    // Verify the custom cookie options were applied
    const cookies = (ctx.cookie as any).outgoingCookies as string[];
    assert.ok(cookies[0].includes('custom-csrf='));
    assert.ok(cookies[0].includes('SameSite=Lax'));
    assert.ok(!cookies[0].includes('Secure'));
    assert.ok(!cookies[0].includes('HttpOnly'));
    assert.ok(cookies[0].includes('Path=/api'));
});

test('Enterprise: Ignore routes fallthrough (no match)', async () => {
    const middleware = csrf({ ignore: ['/public', /^\/assets\/.*/] });
    const ctx = createMockContext('POST');
    ctx.req.url = '/private/data';
    // Since it doesn't match, it should fall through to validation and fail (403)
    await middleware(ctx);
    assert.equal(ctx.res.statusCode, 403);
});

test('Enterprise: Ignore routes handles missing req.url gracefully', async () => {
    const middleware = csrf({ ignore: ['/'] });
    const ctx = createMockContext('POST');
    ctx.req.url = undefined; // Force fallback to '/'
    const result = await middleware(ctx);
    // Since it falls back to '/' and the ignore array contains '/', it should pass
    assert.equal(result, CONTINUE_PIPELINE);
});
