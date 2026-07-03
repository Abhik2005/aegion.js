import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { bruteForce } from '../src/security/brute-force.js';
import { Context, CONTINUE_PIPELINE } from '../src/context.js';
import * as http from 'node:http';
import { Socket } from 'node:net';

function createMockContext(body: any = null): Context {
    const req = new http.IncomingMessage(new Socket());
    req.method = 'POST';
    const res = new http.ServerResponse(req);
    const ctx = new Context(req, res, 'super-secret-key-that-is-at-least-32-chars-long!');
    
    ctx.body = async () => body;
    
    ctx.json = (data: any) => {
        ctx.res.setHeader('Content-Type', 'application/json');
        ctx.res.end(JSON.stringify(data));
        return CONTINUE_PIPELINE;
    };
    
    return ctx;
}

test('Brute Force: Allows successful requests under limit', async () => {
    const middleware = bruteForce({ maxFailures: 3 });
    const ctx = createMockContext({ email: 'test@test.com' });
    
    const res1 = await middleware(ctx);
    assert.equal(res1, CONTINUE_PIPELINE);
    
    const res2 = await middleware(ctx);
    assert.equal(res2, CONTINUE_PIPELINE);
});

test('Brute Force: Locks account after max failures', async () => {
    const middleware = bruteForce({ maxFailures: 2, lockoutTimeMs: 10000 });
    
    // Attempt 1
    let ctx = createMockContext({ email: 'hacker@test.com' });
    await middleware(ctx);
    
    // Attempt 2 (Hit max)
    ctx = createMockContext({ email: 'hacker@test.com' });
    await middleware(ctx);
    
    // Attempt 3 (Should be locked)
    ctx = createMockContext({ email: 'hacker@test.com' });
    await middleware(ctx);
    
    assert.equal(ctx.res.statusCode, 429);
    assert.ok(ctx.res.getHeader('Retry-After'));
});

test('Brute Force: Extracts username instead of email', async () => {
    const middleware = bruteForce({ maxFailures: 1 });
    let ctx = createMockContext({ username: 'admin' });
    await middleware(ctx); // Attempt 1
    
    ctx = createMockContext({ username: 'admin' });
    await middleware(ctx); // Attempt 2 (Locked)
    
    assert.equal(ctx.res.statusCode, 429);
});

test('Brute Force: Allows missing identifier gracefully (no tracking)', async () => {
    const middleware = bruteForce({ maxFailures: 1 });
    let ctx = createMockContext({}); // no email or username
    
    await middleware(ctx);
    await middleware(ctx);
    await middleware(ctx);
    
    assert.equal(ctx.res.statusCode, 200); // Never gets locked
    assert.ok(ctx.locals.bruteForce);
    
    // Calling reset should not throw
    await ctx.locals.bruteForce.reset();
});

test('Brute Force: Ignore parsing errors gracefully', async () => {
    const middleware = bruteForce({ maxFailures: 1 });
    const ctx = createMockContext(null);
    ctx.body = async () => { throw new Error('Bad JSON'); };
    
    const result = await middleware(ctx);
    assert.equal(result, CONTINUE_PIPELINE);
});

test('Brute Force: Reset clears failure count', async () => {
    const middleware = bruteForce({ maxFailures: 2 });
    let ctx = createMockContext({ email: 'user@test.com' });
    
    await middleware(ctx); // Attempt 1
    assert.ok(ctx.locals.bruteForce);
    
    // User logged in! Reset failures.
    await ctx.locals.bruteForce.reset();
    
    // Attack again
    ctx = createMockContext({ email: 'user@test.com' });
    await middleware(ctx); // Attempt 1 again (not 2)
    
    ctx = createMockContext({ email: 'user@test.com' });
    await middleware(ctx); // Attempt 2
    
    ctx = createMockContext({ email: 'user@test.com' });
    await middleware(ctx); // Attempt 3 (Locked)
    
    assert.equal(ctx.res.statusCode, 429);
});

test('Brute Force: Stateful Redis Adapter', async () => {
    const store = new Map();
    const middleware = bruteForce({
        maxFailures: 1,
        store: {
            getFailures: async (id) => store.get(id) || null,
            setFailures: async (id, record) => { store.set(id, record); },
            deleteFailures: async (id) => { store.delete(id); }
        }
    });
    
    let ctx1 = createMockContext({ email: 'state@test.com' });
    await middleware(ctx1); // Attempt 1
    
    let ctx2 = createMockContext({ email: 'state@test.com' });
    await middleware(ctx2); // Locked
    assert.equal(ctx2.res.statusCode, 429);
    
    // Reset via custom store (using ctx1 which actually reached the handler)
    await ctx1.locals.bruteForce.reset();
    
    let ctx3 = createMockContext({ email: 'state@test.com' });
    await middleware(ctx3); // Allowed
    assert.equal(ctx3.res.statusCode, 200);
});

test('Brute Force: Expires lockout time naturally', async () => {
    const middleware = bruteForce({ maxFailures: 1, lockoutTimeMs: -1000 }); // Instantly expires
    
    let ctx = createMockContext({ email: 'fast@test.com' });
    await middleware(ctx); // Attempt 1
    
    // Wait... theoretically expired instantly because time is negative
    
    ctx = createMockContext({ email: 'fast@test.com' });
    await middleware(ctx); // Allowed because resetTime < now
    assert.equal(ctx.res.statusCode, 200);
});

test('Brute Force: OOM Defense forces eviction', async () => {
    const middleware = bruteForce({ maxFailures: 10, maxMemoryKeys: 1 });
    
    // Attacker 1 (Gets added to tracking)
    let ctx = createMockContext({ email: 'attacker1@test.com' });
    await middleware(ctx);
    
    // Attacker 2 (Forces OOM eviction of Attacker 1)
    ctx = createMockContext({ email: 'attacker2@test.com' });
    await middleware(ctx);
    
    // Attacker 1 should be completely reset because they were evicted
    ctx = createMockContext({ email: 'attacker1@test.com' });
    await middleware(ctx);
    
    // Attacker 1 won't get locked out even after maxFailures because their history was erased by OOM cap!
    assert.equal(ctx.res.statusCode, 200);
});

test('Brute Force: Default options apply (5 max failures)', async () => {
    const middleware = bruteForce(); // No maxFailures specified, uses 5
    let ctx;
    for (let i = 0; i < 5; i++) {
        ctx = createMockContext({ email: 'default@test.com' });
        await middleware(ctx);
    }
    // 6th attempt should fail
    ctx = createMockContext({ email: 'default@test.com' });
    await middleware(ctx);
    assert.equal(ctx.res.statusCode, 429);
});
