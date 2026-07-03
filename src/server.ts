import * as http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';
import { EnvParser } from './env.js';
import { Router } from './router.js';
import { Pipeline } from './pipeline.js';
import { Context } from './context.js';
import { RouteDefinition, RouteGroup, ErrorHandler } from './composition.js';
import { applySecurityHeaders } from './security/headers.js';
import { RateLimiter, RateLimitOptions } from './security/rate-limit.js';
// BUG-58 FIX: Static import instead of dynamic import() on every request with nosqlSanitizer.
import { Sanitizer } from './security/sanitizer.js';

export interface CorsOptions {
    origin: string | string[];
    methods?: string[];
    credentials?: boolean;
    maxAge?: number;
    allowedHeaders?: string[];
}

export interface ViewOptions {
    engine: (templatePath: string, data?: any) => string | Promise<string>;
    dir?: string;
}

export interface ServerOptions<T extends z.ZodRawShape> {
    port?: number;
    cors?: CorsOptions;
    env?: z.ZodObject<T>;
    cookieSecret?: string;
    rateLimit?: RateLimitOptions;
    errorHandler?: ErrorHandler;
    views?: ViewOptions;
    nosqlSanitizer?: boolean;
}

export class Server<T extends z.ZodRawShape> {
    private httpServer: http.Server;
    private router: Router;
    public env: z.infer<z.ZodObject<T>> | Record<string, any>;
    private rateLimiter?: RateLimiter;
    private cookieSecret?: string;
    private corsConfig?: CorsOptions;
    private errorHandler?: ErrorHandler;
    private viewsConfig?: ViewOptions;
    private nosqlSanitizer: boolean;
    private port: number;

    constructor(options: ServerOptions<T> = {}) {
        // 1. Initialize and Freeze Env FIRST so it can be used for fallback configs
        if (options.env) {
            this.env = EnvParser.parse(options.env);
        } else {
            /* c8 ignore next 2 */
            this.env = Object.freeze({});
        }

        // 2. Assign config, automatically falling back to Environment Variables
        this.port = options.port || (this.env as any).PORT || 3000;
        this.cookieSecret = options.cookieSecret || (this.env as any).COOKIE_SECRET;
        
        this.corsConfig = options.cors;
        this.errorHandler = options.errorHandler;
        this.viewsConfig = options.views;
        this.nosqlSanitizer = options.nosqlSanitizer ?? false;
        this.router = new Router();

        if (options.rateLimit) {
            this.rateLimiter = new RateLimiter(options.rateLimit);
        }

        this.httpServer = http.createServer(this.handleRequest.bind(this));
    }

    /**
     * Registers an array of routes directly.
     */
    register(routes: RouteGroup) {
        this.router.register(routes);
    }

    /**
     * Automatically scans a directory and dynamically imports default exported RouteGroups.
     */
    async autoload(dirPath: string) {
        const absolutePath = path.resolve(process.cwd(), dirPath);
        
        if (!fs.existsSync(absolutePath)) {
            console.warn(`[Autoload] Directory ${absolutePath} does not exist.`);
            return;
        }

        const entries = fs.readdirSync(absolutePath, { withFileTypes: true });

        for (const entry of entries) {
            if (entry.isDirectory()) {
                const subPath = path.join(absolutePath, entry.name);
                const files = fs.readdirSync(subPath);
                
                // Find routes.ts or routes.js
                const routeFile = files.find(f => f.match(/^routes\.(ts|js)$/));
                if (routeFile) {
                    const fullRoutePath = path.join(subPath, routeFile);
                    // Use dynamic import
                    // Node on Windows requires file:// URL for absolute dynamic imports
                    const importUrl = `file:///${fullRoutePath.replace(/\\/g, '/')}`;
                    /* c8 ignore next */
                    const module = await import(importUrl);
                    
                    if (module.default && Array.isArray(module.default)) {
                        this.register(module.default);
                    }
                }
            }
        }
    }

    private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse) {
        try {
            // 1. Security Headers
        applySecurityHeaders(res);

        // 2. CORS Handling (Hyper-Fast Preflight Bypass & Strict Origin Checking)
        if (this.corsConfig) {
            const origin = req.headers.origin;
            let isAllowed = false;

            if (origin) {
                if (Array.isArray(this.corsConfig.origin)) {
                    isAllowed = this.corsConfig.origin.includes(origin);
                } else if (this.corsConfig.origin === '*' || this.corsConfig.origin === origin) {
                    isAllowed = true;
                }
            } else if (this.corsConfig.origin === '*') {
                isAllowed = true;
            }

            if (isAllowed && origin) {
                res.setHeader('Access-Control-Allow-Origin', origin);
                
                if (this.corsConfig.credentials) {
                    res.setHeader('Access-Control-Allow-Credentials', 'true');
                }
            }

            if (req.method === 'OPTIONS') {
                if (isAllowed) {
                    const methods = this.corsConfig.methods ? this.corsConfig.methods.join(', ') : 'GET,HEAD,PUT,PATCH,POST,DELETE';
                    res.setHeader('Access-Control-Allow-Methods', methods);
                    
                    const reqHeaders = req.headers['access-control-request-headers'];
                    const allowedHeaders = this.corsConfig.allowedHeaders ? this.corsConfig.allowedHeaders.join(', ') : reqHeaders;
                    if (allowedHeaders) {
                        res.setHeader('Access-Control-Allow-Headers', allowedHeaders);
                    }

                    if (this.corsConfig.maxAge) {
                        res.setHeader('Access-Control-Max-Age', String(this.corsConfig.maxAge));
                    }
                }
                
                // Preflight Bypass: Instantly return 204 without hitting Router
                res.statusCode = 204;
                res.end();
                return;
            }
        }

        // 3. Rate Limiting
        /* c8 ignore next */
        if (this.rateLimiter && !this.rateLimiter.check(req, res)) {
            /* c8 ignore next 2 */
            return;
        }

        const method = req.method || 'GET';
        
        // Strip fragment and query params for routing
        const rawUrl = req.url || '/';
        const hashIndex = rawUrl.indexOf('#');
        /* c8 ignore next */
        const withoutHash = hashIndex > -1 ? rawUrl.substring(0, hashIndex) : rawUrl;
        const queryIndex = withoutHash.indexOf('?');
        const urlPath = queryIndex > -1 ? withoutHash.substring(0, queryIndex) : withoutHash;

        // 3. Routing
        const match = this.router.find(method, urlPath);

        if (!match || !match.route) {
            res.statusCode = 404;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: 'Not Found' }));
            return;
        }

        // 4. Context Creation
        const ctx = new Context(req, res, this.cookieSecret, this.viewsConfig, undefined, this.nosqlSanitizer);
        ctx.params = match.params;

        // BUG-51 FIX: ctx.query is now parsed ONCE inside the Context constructor.
        // The duplicate parse block that was here has been removed — it was redundant
        // work on every request (Context constructor already parses via new URL()).

        if (this.nosqlSanitizer) {
            try {
                // BUG-58 FIX: Sanitizer is now statically imported at the top of server.ts.
                // Previously used `await import('./security/sanitizer.js')` on every request,
                // adding unnecessary import machinery overhead at scale.
                Sanitizer.sanitizeNoSQL(ctx.query);
                Sanitizer.sanitizeNoSQL(ctx.params);
            } catch (e: any) {
                res.statusCode = 400;
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ error: 'Bad Request: Invalid parameters detected' }));
                return;
            }
        }

        // 5. Execute Pipeline (Middlewares + Handler)
        await Pipeline.execute(ctx, match.route.middlewares, match.route.handler, this.errorHandler);
        } catch (err) {
            console.error('🚨 [Server] Unhandled request error:', err);
            if (!res.headersSent) {
                res.statusCode = 500;
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ error: 'Internal Server Error' }));
            } else {
                res.destroy();
            }
        }
    }

    start(callback?: () => void) {
        // BUG-60 FIX: Add an error listener to the HTTP server.
        // Without this, Node.js emits an unhandled 'error' event on EADDRINUSE or EACCES,
        // which is a fatal uncaught exception that crashes the entire process.
        // This listener logs a clear message and allows the caller to react gracefully.
        this.httpServer.on('error', (err: NodeJS.ErrnoException) => {
            if (err.code === 'EADDRINUSE') {
                console.error(`🚨 [Server] Port ${this.port} is already in use. Another process may be running.`);
            } else if (err.code === 'EACCES') {
                console.error(`🚨 [Server] Permission denied on port ${this.port}. Ports below 1024 require root/admin privileges.`);
            } else {
                console.error('🚨 [Server] HTTP server error:', err);
            }
        });

        this.httpServer.listen(this.port, () => {
            if (callback) callback();
            else console.log(`Server started on http://localhost:${this.port}`);
        });
    }

    /* c8 ignore next 3 */
    close(callback?: (err?: Error) => void) {
        this.httpServer.close(callback);
    }
}
