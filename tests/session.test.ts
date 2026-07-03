import { test, describe } from 'node:test';
import * as assert from 'node:assert';
import * as http from 'node:http';
import { Socket } from 'node:net';
import * as crypto from 'node:crypto';
import { Context } from '../src/context.js';
import { jwt, JWTError } from '../src/security/jwt.js';
import { CookieManager } from '../src/cookie.js';
import { SessionManager } from '../src/session.js';

function createMockContext(headers: Record<string, string> = {}): Context {
    const req = new http.IncomingMessage(new Socket());
    req.headers = headers;
    const res = new http.ServerResponse(req);
    // Use a valid 32 character key
    return new Context(req, res, 'super-secret-key-that-is-at-least-32-chars-long!');
}

describe('Stateless JWT Engine & Session Manager', () => {

    describe('JWT Cryptographic Engine', () => {
        const secret = 'super-secret-key-that-is-at-least-32-chars-long!';

        test('should sign and verify successfully', () => {
            const payload = { userId: 123, role: 'admin' };
            const token = jwt.sign(payload, secret, 900);
            
            assert.ok(typeof token === 'string');
            assert.strictEqual(token.split('.').length, 3);

            const decoded = jwt.verify<{ userId: number, role: string }>(token, secret);
            assert.strictEqual(decoded.userId, 123);
            assert.strictEqual(decoded.role, 'admin');
            assert.ok(decoded.iat);
            assert.ok(decoded.exp);
        });

        test('should throw error on tampered signature', () => {
            const payload = { userId: 123 };
            const token = jwt.sign(payload, secret, 900);
            
            // Tamper with payload (middle part)
            const parts = token.split('.');
            parts[1] = Buffer.from(JSON.stringify({ userId: 999 })).toString('base64url');
            const tamperedToken = parts.join('.');

            assert.throws(() => jwt.verify(tamperedToken, secret), JWTError, /Signature verification failed/);
        });

        test('should throw error on expired token', async () => {
            const payload = { userId: 123 };
            const token = jwt.sign(payload, secret, -1); // Expired 1 second ago

            assert.throws(() => jwt.verify(token, secret), JWTError, /Token expired/);
        });
        
        test('should throw error on malformed format', () => {
            assert.throws(() => jwt.verify('not.a.token', secret), JWTError, /Failed to parse JWT payload/); // 3 parts, but not valid json/base64
            assert.throws(() => jwt.verify('only.two', secret), JWTError, /Malformed JWT/); // Less than 3 parts
            assert.throws(() => jwt.verify('', secret), JWTError, /Invalid token format/);
            
            // Invalid JSON payload
            const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
            const invalidJsonStr = Buffer.from('not json').toString('base64url');
            const dataToSign = `${header}.${invalidJsonStr}`;
            const sig = crypto.createHmac('sha256', secret).update(dataToSign).digest();
            const validSig = Buffer.from(sig).toString('base64url');
            
            assert.throws(() => jwt.verify(`${dataToSign}.${validSig}`, secret), JWTError, /Failed to parse JWT payload/);
        });
    });

    describe('SessionManager Orchestrator', () => {
        
        test('should throw if secret key is too weak', () => {
            const cookieMgr = new CookieManager(new http.IncomingMessage(new Socket()), new http.ServerResponse(new http.IncomingMessage(new Socket())));
            assert.throws(() => new SessionManager(cookieMgr, 'weak'), /cryptographically strong/);
        });

        test('should create dual tokens with secure default cookies', () => {
            const ctx = createMockContext();
            ctx.session.create({ userId: 555 });
            
            const cookies = ctx.res.getHeader('Set-Cookie') as string[];
            assert.ok(cookies, 'Cookies should be set');
            assert.strictEqual(cookies.length, 2);
            
            // Validate secure flags
            assert.ok(cookies[0].includes('HttpOnly'));
            assert.ok(cookies[0].includes('SameSite=Strict'));
            assert.ok(cookies[0].includes('aegion_access='));
            assert.ok(cookies[1].includes('aegion_refresh='));
        });

        test('should instantly get payload if access token is valid (zero rotation needed)', () => {
            const ctx1 = createMockContext();
            ctx1.session.create({ id: 99 });
            const cookies = ctx1.res.getHeader('Set-Cookie') as string[];
            
            // Simulate next request with those cookies
            const cookieStr = cookies.map(c => c.split(';')[0]).join('; ');
            const ctx2 = createMockContext({ cookie: cookieStr });
            
            const session = ctx2.session.get<{ id: number }>();
            assert.ok(session);
            assert.strictEqual(session.id, 99);
            // Ensure no rotation occurred (no new Set-Cookie header)
            assert.strictEqual(ctx2.res.getHeader('Set-Cookie'), undefined);
        });

        test('should automatically rotate if access token is expired but refresh is valid', () => {
            // First, create a SessionManager with a 0 second access token to force expiration
            const req1 = new http.IncomingMessage(new Socket());
            const res1 = new http.ServerResponse(req1);
            const cookieMgr = new CookieManager(req1, res1);
            const secret = 'super-secret-key-that-is-at-least-32-chars-long!';
            const mgr = new SessionManager(cookieMgr, secret, { accessExpiresIn: -1 }); // Instantly expires
            
            mgr.create({ id: 42 });
            const cookies = res1.getHeader('Set-Cookie') as string[];
            const cookieStr = cookies.map(c => c.split(';')[0]).join('; ');

            // Simulate next request
            const req2 = new http.IncomingMessage(new Socket());
            req2.headers = { cookie: cookieStr };
            const res2 = new http.ServerResponse(req2);
            const cookieMgr2 = new CookieManager(req2, res2);
            // Normal manager for second request
            const mgr2 = new SessionManager(cookieMgr2, secret); 
            
            const session = mgr2.get<{ id: number }>();
            assert.ok(session);
            assert.strictEqual(session.id, 42);
            
            // Since rotation occurred, a NEW set of cookies should have been issued
            const newCookies = res2.getHeader('Set-Cookie') as string[];
            assert.ok(newCookies);
            assert.strictEqual(newCookies.length, 2);
        });

        test('should destroy session and return null if both tokens tampered or expired', () => {
            const secret = 'super-secret-key-that-is-at-least-32-chars-long!';
            
            // Generate valid JWT structure but invalid signature
            const badAccess = jwt.sign({ id: 1 }, secret, 900) + 'tamper';
            const badRefresh = jwt.sign({ _rotate: true, id: 1 }, secret, 900) + 'tamper';
            
            const ctx = createMockContext({ cookie: `aegion_access=${badAccess}; aegion_refresh=${badRefresh}` });
            const session = ctx.session.get();
            
            assert.strictEqual(session, null);
            // Should have wiped the cookies
            const cookies = ctx.res.getHeader('Set-Cookie') as string[];
            assert.ok(cookies);
            assert.ok(cookies[0].includes('Max-Age=0')); // Deleted
        });

        test('should destroy session and return null if access token is expired AND refresh token is tampered', () => {
            const req1 = new http.IncomingMessage(new Socket());
            const res1 = new http.ServerResponse(req1);
            const cookieMgr = new CookieManager(req1, res1);
            const secret = 'super-secret-key-that-is-at-least-32-chars-long!';
            const mgr = new SessionManager(cookieMgr, secret, { accessExpiresIn: -1 }); // Instantly expires
            
            mgr.create({ id: 42 });
            const cookies = res1.getHeader('Set-Cookie') as string[];
            // Break the refresh token by appending 'tamper'
            const cookieStr = cookies.map(c => c.split(';')[0]).join('; ') + 'tamper';

            const req2 = new http.IncomingMessage(new Socket());
            req2.headers = { cookie: cookieStr };
            const res2 = new http.ServerResponse(req2);
            const cookieMgr2 = new CookieManager(req2, res2);
            const mgr2 = new SessionManager(cookieMgr2, secret); 
            
            const session = mgr2.get();
            assert.strictEqual(session, null);
            
            const newCookies = res2.getHeader('Set-Cookie') as string[];
            assert.ok(newCookies[0].includes('Max-Age=0')); // Destroy called during rotation catch block
        });
        
        test('should allow developer override on cookie configs', () => {
            const req = new http.IncomingMessage(new Socket());
            const res = new http.ServerResponse(req);
            const cookieMgr = new CookieManager(req, res);
            const mgr = new SessionManager(cookieMgr, 'super-secret-key-that-is-at-least-32-chars-long!', {
                refreshExpiresIn: 10000,
                cookieOptions: { httpOnly: false, sameSite: 'Lax' } // Developer freedom
            });
            
            mgr.create({ test: 1 });
            const cookies = res.getHeader('Set-Cookie') as string[];
            
            assert.ok(!cookies[0].includes('HttpOnly'));
            assert.ok(cookies[0].includes('SameSite=Lax'));
        });
    });
});
