import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { EnvParser } from '../src/env.js';
import { z } from 'zod';
import * as fs from 'node:fs';

test('EnvParser MUST strictly parse .env files and freeze the memory object', () => {
    // Create a fake .env file
    fs.writeFileSync('.env.test', 'DATABASE_URL=postgres://localhost:5432\n\n# This is a comment\nPORT=8080\nAPI_KEY=secret');
    
    const schema = z.object({
        DATABASE_URL: z.string().url(),
        PORT: z.string().transform(Number),
        API_KEY: z.string()
    });

    const env = EnvParser.parse(schema, '.env.test');
    
    assert.equal(env.DATABASE_URL, 'postgres://localhost:5432');
    assert.equal(env.PORT, 8080);
    assert.equal(env.API_KEY, 'secret');

    // Mathematical proof of Supply-Chain Reflection Defense: 
    // Object MUST be frozen so malicious dependencies cannot overwrite env variables
    assert.equal(Object.isFrozen(env), true);
    
    try {
        (env as any).PORT = 9999;
    } catch (e) {
        // Strict mode will throw error when modifying frozen object
    }
    assert.equal(env.PORT, 8080); // Value must not have changed

    // Cleanup
    fs.unlinkSync('.env.test');
});

test('EnvParser MUST throw startup error if required variable is missing', () => {
    fs.writeFileSync('.env.test2', 'PORT=8080');
    
    const schema = z.object({
        DATABASE_URL: z.string().url(), // Missing!
        PORT: z.string()
    });

    try {
        EnvParser.parse(schema, '.env.test2');
        assert.fail('Should have thrown validation error');
    } catch (err: any) {
        assert.ok(err.issues || err.name === 'ZodError' || err.message.includes('Required'));
    }

    fs.unlinkSync('.env.test2');
});
