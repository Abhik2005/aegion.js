import * as http from 'node:http';
import * as https from 'node:https';
import * as http2 from 'node:http2';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';
import { EnvParser } from './env.js';
import { Router } from './router.js';
import { Pipeline } from './pipeline.js';
import { Context, ContextOptions } from './context.js';
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

/**
 * TLS certificate configuration for HTTPS or HTTP/2 servers.
 *
 * Each value can be either:
 *   - A file path string (e.g. './certs/server.key') — Aegion reads the file automatically.
 *   - A raw PEM string (starts with '-----BEGIN') — passed directly to Node's TLS engine.
 *   - A Buffer — for certificates fetched at runtime from a cloud secret vault.
 */
export interface TlsOptions {
    /** Path to or raw content of the TLS private key (.pem / .key) */
    key: string | Buffer;
    /** Path to or raw content of the TLS certificate (.pem / .crt) */
    cert: string | Buffer;
    /** Optional CA certificate chain for mutual TLS (mTLS) */
    ca?: string | Buffer;
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
    /**
     * TLS configuration for HTTPS / HTTP2 mode.
     *
     * Certificate paths are resolved from the process working directory.
     * Aegion automatically reads file paths — you do NOT need to call fs.readFileSync() yourself.
     *
     * Falls back to TLS_KEY_PATH and TLS_CERT_PATH environment variables if not provided here.
     *
     * @example
     * // File path (Aegion reads it automatically)
     * tls: { key: './certs/server.key', cert: './certs/server.crt' }
     */
    tls?: TlsOptions;
    /**
     * Enable HTTP/2 multiplexing.
     *
     * - If TLS certificates are found (via options.tls or .env), boots an HTTP/2 + TLS server (h2).
     * - If no certificates are found, boots a cleartext HTTP/2 server (h2c) — useful for
     *   internal microservices behind a TLS-terminating load balancer.
     *
     * @default false
     */
    http2?: boolean;
}

/**
 * Resolves a TLS field value to a Buffer.
 *
 * Accepts:
 *   - A file path string → reads the file from disk
 *   - A raw PEM string (starts with '-----BEGIN') → converts directly to Buffer
 *   - A Buffer → returned as-is
 */
function resolveTlsField(value: string | Buffer): Buffer {
    if (Buffer.isBuffer(value)) return value;

    // Raw PEM content — pass through directly
    if (value.trimStart().startsWith('-----BEGIN')) {
        return Buffer.from(value, 'utf8');
    }

    // File path — resolve relative to the process working directory
    const resolved = path.resolve(process.cwd(), value);
    if (!fs.existsSync(resolved)) {
        throw new Error(`[Server] TLS file not found: ${resolved}`);
    }
    return fs.readFileSync(resolved);
}

export class Server<T extends z.ZodRawShape> {
    // The underlying Node.js server — can be http.Server, https.Server, or http2.Http2SecureServer
    private httpServer: http.Server | https.Server | http2.Http2SecureServer | http2.Http2Server;
    private router: Router;
    public env: z.infer<z.ZodObject<T>> | Record<string, any>;
    private rateLimiter?: RateLimiter;
    private cookieSecret?: string;
    private corsConfig?: CorsOptions;
    private errorHandler?: ErrorHandler;
    private viewsConfig?: ViewOptions;
    private nosqlSanitizer: boolean;
    private port: number;
    /** Resolved protocol label used in start() log output */
    private protocol: 'http' | 'https' | 'http2';

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

        this.corsConfig    = options.cors;
        this.errorHandler  = options.errorHandler;
        this.viewsConfig   = options.views;
        this.nosqlSanitizer = options.nosqlSanitizer ?? false;
        this.router = new Router();

        if (options.rateLimit) {
            this.rateLimiter = new RateLimiter(options.rateLimit);
        }

        // 3. Resolve TLS certificates
        //    Priority: options.tls → TLS_KEY_PATH / TLS_CERT_PATH env vars → none (plain HTTP)
        let tlsContext: { key: Buffer; cert: Buffer; ca?: Buffer } | undefined;

        const rawTls = options.tls;
        const envKeyPath  = (this.env as any).TLS_KEY_PATH  as string | undefined;
        const envCertPath = (this.env as any).TLS_CERT_PATH as string | undefined;

        if (rawTls) {
            tlsContext = {
                key:  resolveTlsField(rawTls.key),
                cert: resolveTlsField(rawTls.cert),
                ...(rawTls.ca ? { ca: resolveTlsField(rawTls.ca) } : {})
            };
        } else if (envKeyPath && envCertPath) {
            tlsContext = {
                key:  resolveTlsField(envKeyPath),
                cert: resolveTlsField(envCertPath)
            };
        }

        const useHttp2 = options.http2 === true;
        const handler  = this.handleRequest.bind(this);

        // TypeScript structural mismatch: Http2ServerRequest is missing headersDistinct and
        // trailersDistinct (added to IncomingMessage in newer @types/node) so the two types
        // are not directly assignable. At runtime with allowHTTP1: true they share a
        // compatible API surface. We use a double assertion (as unknown as) — the TypeScript
        // blessed escape hatch for safe-but-unprovable conversions.
        type Http2Handler = (req: http2.Http2ServerRequest, res: http2.Http2ServerResponse<http2.Http2ServerRequest>) => void;

        // 4. Boot the correct server based on the resolved configuration
        //
        //   [http2 + TLS] → http2.createSecureServer  (h2 with HTTP/1.1 fallback)
        //   [http2 only]  → http2.createServer         (cleartext h2c — behind a load balancer)
        //   [TLS only]    → https.createServer          (HTTPS/1.1)
        //   [plain]       → http.createServer           (HTTP/1.1)
        if (useHttp2 && tlsContext) {
            this.protocol   = 'http2';
            this.httpServer = http2.createSecureServer(
                { ...tlsContext, allowHTTP1: true },
                handler as unknown as Http2Handler
            );
        } else if (useHttp2) {
            this.protocol   = 'http2';
            // Cleartext HTTP/2 (h2c) — useful for internal services behind a TLS load balancer
            console.warn('[Server] HTTP/2 enabled without TLS certificates. Starting cleartext h2c server. This is not recommended for public-facing endpoints.');
            this.httpServer = http2.createServer(
                handler as unknown as Http2Handler
            );
        } else if (tlsContext) {
            this.protocol   = 'https';
            this.httpServer = https.createServer(tlsContext, handler);
        } else {
            this.protocol   = 'http';
            this.httpServer = http.createServer(handler);
        }
    }

    /**
     * Registers an array of routes directly.
     */
    register(routes: RouteGroup) {
        this.router.register(routes);
    }

    /**
     * Automatically scans a directory recursively and dynamically imports
     * default exported RouteGroups from any `routes.ts` or `routes.js` file
     * found at any depth within the directory tree.
     */
    async autoload(dirPath: string) {
        const absolutePath = path.resolve(process.cwd(), dirPath);

        if (!fs.existsSync(absolutePath)) {
            console.warn(`[Autoload] Directory ${absolutePath} does not exist.`);
            return;
        }

        await this._autoloadDir(absolutePath);
    }

    /**
     * Internal recursive helper for autoload().
     * Walks the directory tree, registers any routes file found, then recurses
     * into subdirectories — so deeply nested route files are always discovered.
     */
    private async _autoloadDir(dirPath: string): Promise<void> {
        const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });

        // Check if this directory itself contains a routes file
        const routeEntry = entries.find(
            e => e.isFile() && /^routes\.(ts|js)$/.test(e.name)
        );

        if (routeEntry) {
            const fullRoutePath = path.join(dirPath, routeEntry.name);
            // Node on Windows requires file:// URL for absolute dynamic imports
            const importUrl = `file:///${fullRoutePath.replace(/\\/g, '/')}`;
            /* c8 ignore next */
            const module = await import(importUrl);

            if (module.default && Array.isArray(module.default)) {
                this.register(module.default);
            }
        }

        // Recurse into every subdirectory
        for (const entry of entries) {
            if (entry.isDirectory()) {
                await this._autoloadDir(path.join(dirPath, entry.name));
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

            // 4. Routing
            const match = this.router.find(method, urlPath);

            if (!match || !match.route) {
                res.statusCode = 404;
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ error: 'Not Found' }));
                return;
            }

            // 5. Context Creation
            const ctx = new Context(req, res, {
                secretKey:      this.cookieSecret,
                views:          this.viewsConfig,
                nosqlSanitizer: this.nosqlSanitizer,
            });
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

            // 6. Execute Pipeline (Middlewares + Handler)
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
            if (callback) {
                callback();
            } else {
                const label = this.protocol === 'http2'
                    ? `HTTP/2 (${this.protocol === 'http2' ? 'h2' : 'h2c'})`
                    : this.protocol.toUpperCase();
                console.log(`Server started on ${this.protocol === 'http' ? 'http' : 'https'}://localhost:${this.port} [${label}]`);
            }
        });
    }

    /* c8 ignore next 3 */
    close(callback?: (err?: Error) => void) {
        this.httpServer.close(callback);
    }
}
