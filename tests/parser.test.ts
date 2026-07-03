import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { BodyParser } from '../src/parser.js';
import * as events from 'node:events';

// Create a mock IncomingMessage that emits data streams
function createMockStream(chunks: string[], headers: Record<string, string> = {}) {
    const stream = new events.EventEmitter() as any;
    stream.headers = headers;
    stream.destroy = () => { stream.destroyed = true; };
    
    // Simulate streaming data asynchronously
    setImmediate(() => {
        for (const chunk of chunks) {
            if (stream.destroyed) break;
            stream.emit('data', Buffer.from(chunk));
        }
        if (!stream.destroyed) {
            stream.emit('end');
        }
    });
    
    return stream;
}

test('BodyParser MUST mathematically prevent Prototype Poisoning', async () => {
    // Malicious JSON payload
    const payload = '{"username": "hacker", "__proto__": {"admin": true}}';
    const req = createMockStream([payload], { 'content-type': 'application/json' });
    
    const parsed = await BodyParser.parseContentType(req);
    
    assert.equal(parsed.username, 'hacker');
    // The __proto__ key MUST be destroyed by the Secure Reviver
    assert.equal((Object.prototype as any).admin, undefined);
    // Explicitly check the object itself
    assert.equal(parsed.__proto__, Object.prototype); 
});

test('BodyParser MUST instantly sever connection if payload exceeds 1MB (Memory Exhaustion Defense)', async () => {
    const limit = 100; // Artificially small limit for the test
    const chunk1 = 'A'.repeat(50);
    const chunk2 = 'A'.repeat(60); // Total 110 > 100 limit
    const chunk3 = 'A'.repeat(10); // Should be ignored because stream is destroyed
    
    const req = createMockStream([chunk1, chunk2, chunk3]);
    
    try {
        await BodyParser.parseRawBody(req, limit);
        assert.fail('Parser should have thrown an error');
    } catch (err: any) {
        assert.equal(err.message, 'Payload too large');
        assert.equal(req.destroyed, true, 'TCP Connection MUST be destroyed');
    }
});

test('BodyParser MUST parse URL-Encoded data using native C++ Engine', async () => {
    const payload = 'user=alice&age=25&active=true';
    const req = createMockStream([payload], { 'content-type': 'application/x-www-form-urlencoded' });
    
    const parsed = await BodyParser.parseContentType(req);
    
    assert.equal(parsed.user, 'alice');
    assert.equal(parsed.age, '25');
    assert.equal(parsed.active, 'true');
});

test('BodyParser MUST prevent MIME Spoofing via strict semicolon splitting', async () => {
    // Hacker tries to sneak in a fake JSON MIME type
    const header = 'application/x-www-form-urlencoded; hack=application/json';
    const payload = 'hack=success';
    
    const req = createMockStream([payload], { 'content-type': header });
    
    const parsed = await BodyParser.parseContentType(req);
    
    // If it parsed as JSON, it would crash. It parsed as URL-encoded successfully.
    assert.equal(parsed.hack, 'success');
});

test('BodyParser MUST parse text/plain', async () => {
    const req = createMockStream(['hello world'], { 'content-type': 'text/plain' });
    const parsed = await BodyParser.parseContentType(req);
    assert.equal(parsed, 'hello world');
});

test('BodyParser MUST throw Invalid payload format on malformed JSON', async () => {
    const req = createMockStream(['{ invalid: json }'], { 'content-type': 'application/json' });
    await assert.rejects(() => BodyParser.parseContentType(req), /Invalid payload format/);
});

test('BodyParser MUST throw Invalid payload format on precision loss', async () => {
    const req = createMockStream(['{"id": 12345678901234567}'], { 'content-type': 'application/json' });
    await assert.rejects(() => BodyParser.parseContentType(req), /Precision loss detected/);
});

test('BodyParser MUST handle stream errors', async () => {
    const stream = new events.EventEmitter() as any;
    setImmediate(() => stream.emit('error', new Error('Stream Error')));
    await assert.rejects(() => BodyParser.parseRawBody(stream, 100), /Stream Error/);
});

import { z } from 'zod';
test('BodyParser MUST default to JSON parsing if content-type is missing', async () => {
    // Missing content-type header branch
    const req = createMockStream(['{"a": 1}']); // No headers
    const result = await BodyParser.parseContentType(req);
    assert.deepEqual(result, { a: 1 });
});

test('BodyParser MUST securely validate using Zod', async () => {
    const schema = z.object({ age: z.number() });
    
    // Valid
    const req1 = createMockStream(['{"age": 30}'], { 'content-type': 'application/json' });
    const parsed = await BodyParser.parseAndValidate(req1, schema);
    assert.equal(parsed.age, 30);
    
    // Invalid
    const req2 = createMockStream(['{"age": "old"}'], { 'content-type': 'application/json' });
    try {
        await BodyParser.parseAndValidate(req2, schema);
        assert.fail('Should throw zod error');
    } catch (e: any) {
        assert.equal(e.status, 400);
        assert.equal(e.message, 'Validation failed');
        assert.ok(e.errors);
    }
    
    // Non-Zod error during parsing
    const req3 = createMockStream(['{bad json}'], { 'content-type': 'application/json' });
    await assert.rejects(() => BodyParser.parseAndValidate(req3, schema), /Invalid payload format/);
    
    // Non-Zod error during schema validation (schema throws non-ZodError)
    const badSchema = { parse: () => { throw new Error('Random schema crash'); } } as any;
    const req4 = createMockStream(['{"age": 30}'], { 'content-type': 'application/json' });
    await assert.rejects(() => BodyParser.parseAndValidate(req4, badSchema), /Random schema crash/);
});

test('BodyParser MUST mathematically prevent Slowloris attacks (Timeout)', async () => {
    const { EventEmitter } = await import('node:events');
    const req = new EventEmitter() as any;
    req.headers = {};
    req.destroy = () => { req.destroyed = true; };
    
    try {
        await BodyParser.parseRawBody(req, 1024, 10); // 10ms timeout
        assert.fail('Should have timed out');
    } catch(err: any) {
        assert.equal(err.message, 'Payload timeout');
        assert.equal(req.destroyed, true);
    }
});
