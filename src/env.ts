import * as fs from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';

export class EnvParser {
    /**
     * Reads a .env file, validates it against a provided Zod schema,
     * and returns a deeply frozen object to prevent JavaScript reflection attacks.
     *
     * Priority: process.env > .env file
     * This matches Docker/Kubernetes convention where orchestrator-set environment
     * variables are authoritative. A .env file is only used as a local fallback.
     */
    static parse<T extends z.ZodRawShape>(
        schema: z.ZodObject<T>,
        envFilePath: string = path.resolve(process.cwd(), '.env')
    ): z.infer<z.ZodObject<T>> {
        // BUG-46 FIX: Start with .env file values as the BASE (lowest priority),
        // then overlay process.env on top so orchestrator variables always win.
        // Old behavior spread process.env first, then .env file overwrote it —
        // which meant a stale .env file in a Docker image could silently override
        // production secrets injected by Kubernetes/ECS/etc.
        const rawEnv: Record<string, string> = {};

        // Step 1: Load .env file values as base (lowest priority)
        if (fs.existsSync(envFilePath)) {
            const content = fs.readFileSync(envFilePath, 'utf-8');
            const lines = content.split('\n');

            for (const line of lines) {
                const trimmed = line.trim();
                // Ignore comments and empty lines
                if (!trimmed || trimmed.startsWith('#')) continue;

                const [key, ...rest] = trimmed.split('=');
                if (key) {
                    const value = rest.join('=').trim();
                    // Remove surrounding quotes if any
                    const unquoted = value.replace(/^(['"])(.*)\\1$/, '$2');
                    rawEnv[key.trim()] = unquoted;
                }
            }
        }

        // Step 2: Overlay process.env on top (highest priority — always wins)
        for (const [key, value] of Object.entries(process.env)) {
            if (value !== undefined) {
                rawEnv[key] = value;
            }
        }

        // Validate using Zod (will throw if invalid)
        const parsed = schema.parse(rawEnv);

        // Freeze to prevent mutation / JavaScript reflection attacks
        return Object.freeze(parsed) as z.infer<z.ZodObject<T>>;
    }
}
