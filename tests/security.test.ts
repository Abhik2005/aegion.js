import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { RateLimiter } from '../src/security/rate-limit.js';
import { applySecurityHeaders } from '../src/security/headers.js';
import * as http from 'node:http';

test('RateLimiter MUST strictly block requests over the limit (DoS Protection)', () => {
    // 2 requests per 1000ms
    const limiter = new RateLimiter({ windowMs: 1000, maxRequests: 2, trustProxy: true });
    
    // Test by exposing a test hook or mocking the check function
    // But since the class uses check(req, res), let's mock it
    const req = (ip: string) => ({ headers: { 'x-forwarded-for': ip }, socket: {} } as unknown as http.IncomingMessage);
    const res = { setHeader: () => {}, end: () => {} } as unknown as http.ServerResponse;
    
    // Request 1: Allowed
    assert.equal(limiter.check(req('192.168.1.1'), res), true);
    
    // Request 2: Allowed
    assert.equal(limiter.check(req('192.168.1.1'), res), true);
    
    // Request 3: BLOCKED
    assert.equal(limiter.check(req('192.168.1.1'), res), false);
    
    // Different IP is unaffected
    assert.equal(limiter.check(req('10.0.0.5'), res), true);
});

test('RateLimiter MUST prevent IP Spoofing if trustProxy is false', () => {
    const limiter = new RateLimiter({ windowMs: 1000, maxRequests: 2, trustProxy: false });
    const req = (fakeIp: string, realIp: string) => ({ headers: { 'x-forwarded-for': fakeIp }, socket: { remoteAddress: realIp } } as unknown as http.IncomingMessage);
    const res = { setHeader: () => {}, end: () => {} } as unknown as http.ServerResponse;
    
    assert.equal(limiter.check(req('1.1.1.1', '2.2.2.2'), res), true);
    assert.equal((limiter as any).store.has('2.2.2.2'), true);
    assert.equal((limiter as any).store.has('1.1.1.1'), false);
});

test('Security Headers MUST be injected into the response (Helmet bypass)', () => {
    const headers = new Map<string, string>();
    const res = {
        setHeader: (key: string, value: string) => {
            headers.set(key.toLowerCase(), value);
        },
        hasHeader: (key: string) => headers.has(key.toLowerCase())
    } as unknown as http.ServerResponse;
    
    applySecurityHeaders(res);
    
    // Proof of standard enterprise security headers
    assert.equal(headers.get('x-content-type-options'), 'nosniff');
    assert.equal(headers.get('x-frame-options'), 'DENY');
    assert.ok(headers.get('content-security-policy'));
});

test('RateLimiter MUST cleanup expired IP records', () => {
    const limiter = new RateLimiter({ windowMs: 1000, maxRequests: 2 });
    
    const store = (limiter as any).store;
    // Inject expired record
    store.set('1.1.1.1', { count: 5, resetTime: Date.now() - 10000 });
    // Inject active record
    store.set('2.2.2.2', { count: 1, resetTime: Date.now() + 10000 });
    
    // Trigger cleanup
    (limiter as any).cleanup();
    
    assert.equal(store.has('1.1.1.1'), false);
    assert.equal(store.has('2.2.2.2'), true);
});

test('RateLimiter MUST fallback to socket remoteAddress if x-forwarded-for is missing', () => {
    const limiter = new RateLimiter({ windowMs: 1000, maxRequests: 2 });
    const req = { headers: {}, socket: { remoteAddress: '10.0.0.1' } } as unknown as http.IncomingMessage;
    const res = { setHeader: () => {}, end: () => {} } as unknown as http.ServerResponse;
    assert.equal(limiter.check(req, res), true);
    assert.equal((limiter as any).store.has('10.0.0.1'), true);
    
    // Also test completely missing both
    const reqUnknown = { headers: {}, socket: {} } as unknown as http.IncomingMessage;
    assert.equal(limiter.check(reqUnknown, res), true);
    assert.equal((limiter as any).store.has('unknown'), true);
});
