import { test, describe } from 'node:test';
import * as assert from 'node:assert';
import * as http from 'node:http';
import { Socket } from 'node:net';
import { Context } from '../src/context.js';
import { csp } from '../src/security/csp.js';

function createMockContext(): Context {
    const req = new http.IncomingMessage(new Socket());
    const res = new http.ServerResponse(req);
    const ctx = new Context(req, res, 'a-very-secure-32-byte-secret-key-123456');
    
    // Mock ctx.next
    ctx.next = () => Symbol('CONTINUE_PIPELINE');
    return ctx;
}

describe('Content Security Policy (CSP) Middleware', () => {

    test('should apply strict default-src \'self\' when no options provided', async () => {
        const middleware = csp({ useNonce: false });
        const ctx = createMockContext();
        
        await middleware(ctx);
        const header = ctx.res.getHeader('Content-Security-Policy');
        assert.strictEqual(header, "default-src 'self'");
    });

    test('should generate and inject cryptographically secure nonce by default', async () => {
        const middleware = csp(); // default has useNonce = true
        const ctx = createMockContext();
        
        await middleware(ctx);
        const header = ctx.res.getHeader('Content-Security-Policy') as string;
        
        assert.ok(ctx.locals.nonce, 'Nonce should be generated and stored in locals');
        assert.strictEqual(typeof ctx.locals.nonce, 'string');
        assert.strictEqual(ctx.locals.nonce.length, 24); // base64 encoded 16 bytes = 24 chars
        
        assert.ok(header.includes(`'nonce-${ctx.locals.nonce}'`), 'Nonce should be injected into script-src fallback');
        assert.ok(header.includes("default-src 'self'"), 'Should maintain default-src fallback');
    });

    test('should apply custom directives strictly', async () => {
        const middleware = csp({
            useNonce: false,
            directives: {
                defaultSrc: ["'self'"],
                scriptSrc: ["'self'", "https://apis.google.com"],
                styleSrc: ["'self'", "'unsafe-inline'"],
                imgSrc: ["'self'", "data:", "https://images.stripe.com"],
                connectSrc: ["'self'", "wss://socket.my-app.com"]
            }
        });
        const ctx = createMockContext();
        
        await middleware(ctx);
        const header = ctx.res.getHeader('Content-Security-Policy') as string;
        
        assert.ok(header.includes("default-src 'self'"));
        assert.ok(header.includes("script-src 'self' https://apis.google.com"));
        assert.ok(header.includes("style-src 'self' 'unsafe-inline'"));
        assert.ok(header.includes("img-src 'self' data: https://images.stripe.com"));
        assert.ok(header.includes("connect-src 'self' wss://socket.my-app.com"));
    });
    
    test('should inject nonce into explicit custom directives', async () => {
        const middleware = csp({
            useNonce: true,
            directives: {
                defaultSrc: ["'self'"],
                scriptSrc: ["'self'", "https://apis.google.com"],
                styleSrc: ["'self'"]
            }
        });
        const ctx = createMockContext();
        
        await middleware(ctx);
        const header = ctx.res.getHeader('Content-Security-Policy') as string;
        
        assert.ok(ctx.locals.nonce);
        assert.ok(header.includes(`script-src 'self' https://apis.google.com 'nonce-${ctx.locals.nonce}'`));
        assert.ok(header.includes(`style-src 'self' 'nonce-${ctx.locals.nonce}'`));
    });

    test('should support Report-Only mode without breaking flow', async () => {
        const middleware = csp({
            useNonce: false,
            reportOnly: true,
            directives: {
                defaultSrc: ["'self'"],
                reportUri: ["/api/csp-report"]
            }
        });
        const ctx = createMockContext();
        
        await middleware(ctx);
        const header = ctx.res.getHeader('Content-Security-Policy-Report-Only');
        const standardHeader = ctx.res.getHeader('Content-Security-Policy');
        
        assert.ok(header, 'Should set Report-Only header');
        assert.strictEqual(standardHeader, undefined, 'Should NOT set enforcing header');
        assert.strictEqual(header, "default-src 'self'; report-uri /api/csp-report");
    });
    
});
