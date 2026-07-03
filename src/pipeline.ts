import { Context, CONTINUE_PIPELINE } from './context.js';
import { Middleware, Handler, ErrorHandler } from './composition.js';
import { AsyncLocalStorage } from 'node:async_hooks';

// AsyncLocalStorage to catch swallowed errors in the pipeline
export const executionContext = new AsyncLocalStorage<Context>();

export class Pipeline {
    static async execute(
        ctx: Context,
        middlewares: Middleware[],
        handler: Handler,
        errorHandler?: ErrorHandler
    ): Promise<void> {
        return executionContext.run(ctx, async () => {
            try {
                // 1. Execute Middlewares
                for (const mw of middlewares) {
                    const result = await mw(ctx);

                    // 🚨 FAIL-CLOSED PROTECTION
                    // Check if response was finalized by ctx.json() or ctx.html() FIRST
                    if (ctx.isFinished) {
                        return;
                    }

                    // If they explicitly called return ctx.next(), continue securely
                    if (result === CONTINUE_PIPELINE) {
                        continue;
                    }

                    // 🚨 FAIL-CLOSED PROTECTION
                    // If they didn't call next() and didn't finish the response, assume developer error.
                    if (result === undefined || result === null) {
                        console.error('🚨 [Security: Fail-Closed] Middleware returned void without calling ctx.next(). Pipeline aborted to prevent unauthorized access.');
                        ctx.status(500).json({ error: 'Internal Server Error (Fail-Closed)' });
                        return;
                    }

                    // If they returned something else and didn't use ctx.json, we assume it's the response payload
                    ctx.status(200).json(result);
                    return;
                }

                // 2. Execute Handler
                const result = await handler(ctx);

                // If handler didn't finish response explicitly via ctx.json()
                if (!ctx.isFinished && result !== undefined) {
                    // BUG-39 FIX: Use result == null (null/undefined check) instead of !result.
                    // Previously, returning 0, false, or '' (falsy values) triggered an empty
                    // res.end() instead of serializing the actual value as JSON.
                    if (ctx.res.statusCode === 200 && result == null) {
                        ctx.res.end();
                    } else {
                        ctx.json(result);
                    }
                } else if (!ctx.isFinished && result === undefined) {
                    // Empty 200 OK
                    ctx.res.end();
                }

            } catch (err: any) {
                // Uncaught/Swallowed error caught by top-level Pipeline
                if (err.status && err.message === 'Validation failed') {
                    // Fast-path for Validation Errors
                    if (!ctx.isFinished) ctx.status(400).json(err);
                    return;
                }

                // 1. Execute Custom Error Handler (if provided)
                if (errorHandler) {
                    try {
                        await errorHandler(err, ctx);
                    } catch (handlerErr) {
                        // Suppress handler crashes and fallback to safety
                        console.error('🚨 [Security: Fail-Safe] Custom errorHandler crashed:', handlerErr);
                    }
                } else {
                    // Default logging if no handler
                    console.error('🚨 [Pipeline Error]', err);
                }

                // 2. The Idiot-Proof Fail-Safe Fallback
                if (!ctx.isFinished) {
                    if (ctx.res.headersSent) {
                        ctx.res.end(); // Just end the connection to prevent hanging
                    } else {
                        console.error('🚨 [Security: Fail-Safe] Forced generic 500 response. (Developer forgot to send response or crashed in errorHandler)');
                        ctx.status(500).json({ error: 'Internal Server Error' });
                    }
                }
            }
        });
    }
}
