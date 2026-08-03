import * as http from 'node:http';
import * as crypto from 'node:crypto';
import { z } from 'zod';
import { CookieManager, CookieOptions } from './cookie.js';
import { BodyParser } from './parser.js';
import { UploadManager, UploadedFile } from './upload.js';
import { SessionManager, SessionConfig } from './session.js';
import type { ViewOptions } from './server.js';
import * as path from 'node:path';
// BUG-58 FIX: Static import instead of dynamic import() on every body() call.
import { Sanitizer, SanitizerError } from './security/sanitizer.js';

export const CONTINUE_PIPELINE = Symbol('CONTINUE_PIPELINE');

/**
 * Options bag for the Context constructor.
 * Prefer this over the legacy 6-positional-argument form when constructing
 * a Context manually (e.g. in tests or custom middleware factories).
 */
export interface ContextOptions {
    /** The HMAC secret used to sign cookies and session tokens. */
    secretKey?: string;
    /** View-engine configuration for ctx.render(). */
    views?: ViewOptions;
    /** Session configuration overrides (TTLs, cookie flags). */
    session?: SessionConfig;
    /** Enable NoSQL injection sanitization on query params, route params, and body. */
    nosqlSanitizer?: boolean;
}

export class Context {
    public req: http.IncomingMessage;
    public res: http.ServerResponse;
    public cookie: CookieManager;
    public session: SessionManager;
    public query: Record<string, string> = {};
    /**
     * Route parameters extracted from dynamic URL segments (e.g. :id).
     * Populated by the router before the pipeline executes.
     */
    public params: Record<string, string> = {};
    /**
     * Store data strictly tied to the current request lifecycle.
     * Use this instead of adding custom properties directly to ctx.
     */
    public locals: Record<string, any> & { nonce?: string } = {};
    
    private _statusCode: number = 200;
    private _isFinished: boolean = false;
    private _secretKey?: string;
    private viewsConfig?: ViewOptions;
    private nosqlSanitizer: boolean;

    // Overload 1 — New clean options-bag API (preferred)
    constructor(req: http.IncomingMessage, res: http.ServerResponse, options?: ContextOptions);
    // Overload 2 — Legacy positional API (backward-compatible, existing callsites unaffected)
    constructor(req: http.IncomingMessage, res: http.ServerResponse, secretKey?: string, viewsConfig?: ViewOptions, sessionConfig?: SessionConfig, nosqlSanitizer?: boolean);
    // Implementation
    constructor(
        req: http.IncomingMessage,
        res: http.ServerResponse,
        secretKeyOrOptions?: string | ContextOptions,
        viewsConfig?: ViewOptions,
        sessionConfig?: SessionConfig,
        nosqlSanitizer?: boolean
    ) {
        this.req = req;
        this.res = res;

        // Resolve the two calling conventions into a single set of values
        let secretKey: string | undefined;
        let resolvedViews: ViewOptions | undefined;
        let resolvedSession: SessionConfig | undefined;
        let resolvedSanitizer: boolean;

        if (secretKeyOrOptions !== null && typeof secretKeyOrOptions === 'object') {
            // New options-bag form: new Context(req, res, { secretKey, views, session, nosqlSanitizer })
            secretKey         = secretKeyOrOptions.secretKey;
            resolvedViews     = secretKeyOrOptions.views;
            resolvedSession   = secretKeyOrOptions.session;
            resolvedSanitizer = secretKeyOrOptions.nosqlSanitizer ?? false;
        } else {
            // Legacy positional form: new Context(req, res, secretKey?, viewsConfig?, sessionConfig?, nosqlSanitizer?)
            secretKey         = secretKeyOrOptions as string | undefined;
            resolvedViews     = viewsConfig;
            resolvedSession   = sessionConfig;
            resolvedSanitizer = nosqlSanitizer ?? false;
        }

        this._secretKey       = secretKey;
        this.viewsConfig      = resolvedViews;
        this.nosqlSanitizer   = resolvedSanitizer;
        this.cookie           = new CookieManager(req, res, secretKey);

        // BUG-21 FIX: Replace the hardcoded fallback secret with a per-process
        // random key. The old fallback ('fallback-secret-key-that-is-at-least-32-chars-long')
        // was publicly known — anyone reading the source could forge session tokens for
        // servers that forgot to set cookieSecret. A random key means the session system
        // will simply not persist across restarts (acceptable for the fallback path), but
        // cannot be forged by an external attacker. SessionManager will still throw a clear
        // error if a developer actively tries to use sessions without a proper secret.
        const sessionSecret = secretKey || crypto.randomBytes(32).toString('hex');
        this.session = new SessionManager(this.cookie, sessionSecret, resolvedSession);

        // BUG-51 FIX: Parse query string ONCE here in the constructor.
        // server.ts previously parsed it a second time and overwrote ctx.query — redundant work.
        // The server.ts duplicate parse has been removed.
        try {
            const urlObj = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
            this.query = Object.fromEntries(urlObj.searchParams.entries());
        } catch {
            /* c8 ignore next 2 */
            this.query = {};
        }
    }

    /**
     * Set HTTP Status Code
     */
    status(code: number): this {
        this._statusCode = code;
        this.res.statusCode = code;
        return this;
    }

    /**
     * Send JSON Response
     */
    json(data: any): symbol {
        if (this._isFinished) return CONTINUE_PIPELINE;
        this.res.setHeader('Content-Type', 'application/json');
        const payload = data === undefined ? '' : JSON.stringify(data);
        this.res.end(payload);
        this._isFinished = true;
        return CONTINUE_PIPELINE; // Represents returning a response to stop pipeline
    }

    /**
     * Send raw HTML Response
     */
    html(htmlString: string): symbol {
        if (this._isFinished) return CONTINUE_PIPELINE;
        this.res.setHeader('Content-Type', 'text/html');
        this.res.end(htmlString);
        this._isFinished = true;
        return CONTINUE_PIPELINE;
    }

    /**
     * Compile and render an SSR Template using the configured Server engine
     */
    async render(template: string, data?: any): Promise<symbol> {
        if (!this.viewsConfig || !this.viewsConfig.engine) {
            throw new Error('Template engine not configured in ServerOptions');
        }
        
        const dir = this.viewsConfig.dir || process.cwd();
        const filePath = path.join(dir, template);
        
        // Merge locals with passed data
        const mergedData = { ...this.locals, ...(data || {}) };
        const compiledHtml = await this.viewsConfig.engine(filePath, mergedData);
        
        return this.html(compiledHtml);
    }

    /**
     * Signal to continue the pipeline (Fail-Closed design)
     */
    next(): symbol {
        return CONTINUE_PIPELINE;
    }

    /**
     * Parse JSON body and validate with Zod
     */
    async body<T extends z.ZodTypeAny | Record<string, z.ZodTypeAny>>(rules?: T): Promise<any> {
        let parsedData: any;
        if (!rules) {
            parsedData = await BodyParser.parseAndValidate(this.req);
        } else {
            let compiledSchema: z.ZodTypeAny = rules as any;
            if (!(rules instanceof z.ZodType)) {
                compiledSchema = z.object(rules as Record<string, z.ZodTypeAny>);
            }
            parsedData = await BodyParser.parseAndValidate(this.req, compiledSchema);
        }

        if (this.nosqlSanitizer) {
            // BUG-58 FIX: Sanitizer is now statically imported at the top of the file.
            // Previously, `await import('./security/sanitizer.js')` ran on every request
            // with nosqlSanitizer enabled — even though Node caches the module, the
            // import() machinery overhead accumulates at scale.
            try {
                Sanitizer.sanitizeNoSQL(parsedData);
            } catch (e: any) {
                if (e instanceof SanitizerError) {
                    throw { status: 400, message: 'Validation failed', errors: [{ path: ['body'], message: 'NoSQL Injection Detected' }] };
                }
                /* c8 ignore next 3 */
                throw e;
            }
        }
        return parsedData;
    }

    /**
     * Parse Multipart form data (file uploads) securely
     */
    async upload(options?: { limits?: { fileSize?: number, files?: number } }): Promise<{ fields: Record<string, string>, files: UploadedFile[] }> {
        return UploadManager.parse(this.req, options);
    }

    /**
     * Native Stream Handler
     * Bypasses the synchronous pipeline to stream files directly via Node's C++ core.
     * Uses Content-Length to enable browser progress bars and mid-stream corruption detection.
     */
    stream(readable: import('node:stream').Readable, mimeType: string = 'application/octet-stream', size?: number): symbol {
        if (this._isFinished) return CONTINUE_PIPELINE;
        
        this.res.setHeader('Content-Type', mimeType);
        if (size !== undefined) {
            this.res.setHeader('Content-Length', size.toString());
        }

        // Lock the pipeline instantly
        this._isFinished = true;
        
        // Pipe asynchronously
        readable.pipe(this.res);

        // Fail-Closed Security Trap
        readable.on('error', (err) => {
            console.error('🚨 [Stream Error] The stream crashed mid-flight!', err);
            // Abruptly sever the TCP socket. The browser will detect bytes < Content-Length.
            this.res.destroy();
        });

        return CONTINUE_PIPELINE;
    }

    get isFinished() {
        return this._isFinished;
    }
}
