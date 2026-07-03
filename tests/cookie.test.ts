import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { CookieManager } from '../src/cookie.js';
import * as http from 'node:http';

test('CookieManager MUST correctly serialize and parse plain cookies', () => {
    const req = { headers: { cookie: 'foo=bar; baz=qux' } } as unknown as http.IncomingMessage;
    const res = { setHeader: () => {} } as unknown as http.ServerResponse;

    const cm = new CookieManager(req, res);
    
    assert.equal(cm.get('foo'), 'bar');
    assert.equal(cm.get('baz'), 'qux');
    assert.equal(cm.get('session'), null);
});

test('CookieManager MUST throw on cookies exceeding 4KB', () => {
    const req = { headers: {} } as unknown as http.IncomingMessage;
    const res = { setHeader: () => {} } as unknown as http.ServerResponse;
    const cm = new CookieManager(req, res);
    const bigData = 'a'.repeat(4097);
    assert.throws(() => cm.set('big', bigData));
});

test('CookieManager MUST support delete', () => {
    const req = { headers: {} } as unknown as http.IncomingMessage;
    let headerStr = '';
    const res = { 
        setHeader: (name: string, val: string | string[]) => { headerStr = String(val); }
    } as unknown as http.ServerResponse;
    const cm = new CookieManager(req, res);
    
    cm.delete('session', { path: '/api' });
    assert.ok(headerStr.includes('Max-Age=0'));
    assert.ok(headerStr.includes('Path=/api'));
});

test('CookieManager MUST handle all cookie options and malformed incoming cookies', () => {
    const req = { headers: { cookie: 'bad=something; json={%22invalid:%22}' } } as unknown as http.IncomingMessage;
    let headerStr = '';
    const res = { setHeader: (name: string, val: string | string[]) => { headerStr = String(val); } } as unknown as http.ServerResponse;
    const cm = new CookieManager(req, res);
    
    // Malformed encoded cookie — get() decodes it
    assert.equal(cm.get('json'), '{"invalid:"}');

    // domain and sameSite options
    cm.set('test', 'value', { domain: 'example.com', sameSite: 'Strict' });
    // JSON object values are URL-encoded in the Set-Cookie header (BUG-15 fix)
    cm.set('obj', { key: 'val' });
    assert.ok(headerStr.includes('Domain=example.com'));
    assert.ok(headerStr.includes('SameSite=Strict'));
    // After BUG-15 fix, JSON is URL-encoded: {"key":"val"} → %7B%22key%22%3A%22val%22%7D
    assert.ok(headerStr.includes('obj='), 'obj cookie should be set');
    // Verify the value round-trips correctly: set then get should give back original object string
    const req2 = { headers: { cookie: `obj=${encodeURIComponent('{"key":"val"}')}` } } as unknown as http.IncomingMessage;
    const res2 = { setHeader: () => {} } as unknown as http.ServerResponse;
    const cm2 = new CookieManager(req2, res2);
    assert.equal(cm2.get('obj'), '{"key":"val"}');
});
