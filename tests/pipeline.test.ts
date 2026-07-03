import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { Pipeline } from '../src/pipeline.js';
import { CONTINUE_PIPELINE } from '../src/context.js';

function createMockContext() {
    let statusCode = 200;
    let jsonBody: any = null;
    let finished = false;

    return {
        isFinished: false,
        res: {
            statusCode: 200,
            end: () => { finished = true; }
        },
        status(code: number) {
            statusCode = code;
            this.res.statusCode = code;
            return this;
        },
        json(body: any) {
            jsonBody = body;
            this.isFinished = true;
            finished = true;
        },
        next() {
            return CONTINUE_PIPELINE;
        },
        // Helpers for assertions
        getStatusCode: () => statusCode,
        getJsonBody: () => jsonBody
    } as any;
}

test('Pipeline MUST execute middlewares and handler sequentially', async () => {
    const ctx = createMockContext();
    let steps: string[] = [];
    
    const mw1 = async (c: any) => { steps.push('mw1'); return c.next(); };
    const mw2 = async (c: any) => { steps.push('mw2'); return c.next(); };
    const handler = async (c: any) => { steps.push('handler'); return { ok: true }; };
    
    await Pipeline.execute(ctx, [mw1, mw2], handler);
    
    assert.deepEqual(steps, ['mw1', 'mw2', 'handler']);
    assert.equal(ctx.getStatusCode(), 200);
    assert.deepEqual(ctx.getJsonBody(), { ok: true });
});

test('Pipeline MUST trigger Security Fail-Closed if middleware returns void', async () => {
    const ctx = createMockContext();
    let handlerRan = false;
    
    // Malicious or lazy middleware that forgets to call next() or respond
    const badMw = async (c: any) => { return; };
    const handler = async (c: any) => { handlerRan = true; return { ok: true }; };
    
    await Pipeline.execute(ctx, [badMw], handler);
    
    assert.equal(handlerRan, false, 'Handler MUST NOT run if pipeline fails closed');
    assert.equal(ctx.getStatusCode(), 500);
    assert.deepEqual(ctx.getJsonBody(), { error: 'Internal Server Error (Fail-Closed)' });
});

test('Pipeline MUST catch unhandled crashes and trigger Idiot-Proof Fail-Safe Fallback', async () => {
    const ctx = createMockContext();
    
    const handler = async (c: any) => { 
        throw new Error('Database Password Leaked!');
    };
    
    await Pipeline.execute(ctx, [], handler);
    
    // The library MUST suppress the crash and return a generic 500 error
    assert.equal(ctx.getStatusCode(), 500);
    assert.deepEqual(ctx.getJsonBody(), { error: 'Internal Server Error' });
});

test('Pipeline MUST execute Global Error Handler and fallback securely if handler fails', async () => {
    const ctx = createMockContext();
    let errorHandlerRan = false;
    
    const handler = async (c: any) => { throw new Error('Crash'); };
    const errorHandler = async (err: any, c: any) => {
        errorHandlerRan = true;
        // Intentionally forgetting to call c.json() to test the fallback
    };
    
    await Pipeline.execute(ctx, [], handler, errorHandler);
    
    assert.equal(errorHandlerRan, true);
    assert.equal(ctx.getStatusCode(), 500); // Fail-Safe triggered
    assert.deepEqual(ctx.getJsonBody(), { error: 'Internal Server Error' });
});

test('Pipeline MUST exit if middleware calls json() and returns', async () => {
    const ctx = createMockContext();
    const mw = async (c: any) => { c.json({ early: true }); return; };
    const handler = async (c: any) => { return { ok: true }; };
    
    await Pipeline.execute(ctx, [mw], handler);
    assert.deepEqual(ctx.getJsonBody(), { early: true });
});

test('Pipeline MUST serialize middleware returned objects', async () => {
    const ctx = createMockContext();
    const mw = async (c: any) => { return { intercepted: true }; };
    const handler = async (c: any) => { return { ok: true }; };
    
    await Pipeline.execute(ctx, [mw], handler);
    assert.deepEqual(ctx.getJsonBody(), { intercepted: true });
});

test('Pipeline MUST end empty response if handler returns void', async () => {
    const ctx = createMockContext();
    const handler = async (c: any) => { return; };
    await Pipeline.execute(ctx, [], handler);
    assert.equal(ctx.getStatusCode(), 200);
});

test('Pipeline MUST serialize handler result if no json called', async () => {
    const ctx = createMockContext();
    ctx.res.statusCode = 201; // Not 200
    const handler = async (c: any) => { return { created: true }; };
    await Pipeline.execute(ctx, [], handler);
    assert.deepEqual(ctx.getJsonBody(), { created: true });
});

test('Pipeline MUST serialize falsy-but-non-null handler return values as JSON (BUG-39 fix)', async () => {
    // Previously, returning 0, false, or '' produced an empty body (silent data loss).
    // After BUG-39 fix, these values are correctly serialized as JSON.
    const ctx = createMockContext();
    const handler = async (c: any) => { return false; }; // Falsy but not undefined/null
    await Pipeline.execute(ctx, [], handler);
    // false should be JSON-serialized, not silently dropped as an empty body
    assert.deepEqual(ctx.getJsonBody(), false);
});

test('Pipeline MUST end response without body if handler returns null or undefined', async () => {
    const ctx = createMockContext();
    const handler = async (c: any) => { return undefined; };
    let ended = false;
    ctx.res.end = () => { ended = true; };
    await Pipeline.execute(ctx, [], handler);
    assert.equal(ended, true);
    assert.equal(ctx.getJsonBody(), null);
});

test('Pipeline MUST handle Fast-path validation errors', async () => {
    const ctx = createMockContext();
    const handler = async (c: any) => { throw { status: 400, message: 'Validation failed' }; };
    await Pipeline.execute(ctx, [], handler);
    assert.equal(ctx.getStatusCode(), 400);
    assert.deepEqual(ctx.getJsonBody(), { status: 400, message: 'Validation failed' });
});

test('Pipeline MUST fallback if ErrorHandler crashes', async () => {
    const ctx = createMockContext();
    const handler = async (c: any) => { throw new Error('Crash'); };
    const errorHandler = async (err: any, c: any) => { throw new Error('Handler crash'); };
    
    await Pipeline.execute(ctx, [], handler, errorHandler);
    assert.equal(ctx.getStatusCode(), 500);
    assert.deepEqual(ctx.getJsonBody(), { error: 'Internal Server Error' });
});

test('Pipeline MUST securely end connection if headers are already sent during a crash', async () => {
    const ctx = createMockContext();
    
    // Simulate headers already being sent
    Object.defineProperty(ctx.res, 'headersSent', { value: true, writable: true });
    
    let ended = false;
    ctx.res.end = () => { ended = true; };
    
    const handler = async (c: any) => { throw new Error('Crash after headers'); };
    
    await Pipeline.execute(ctx, [], handler);
    
    // Ensure 500 was NOT set (because headers are sent)
    assert.equal(ctx.getStatusCode(), 200); 
    // Ensure connection was terminated safely
    assert.equal(ended, true);
});
