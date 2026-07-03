import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { RouteGroup } from './composition.js';
import { Context, CONTINUE_PIPELINE } from './context.js';

export interface StaticOptions {
    /**
     * Cache-Control max-age in seconds.
     * @default 86400 (1 day)
     */
    maxAge?: number;
    /**
     * The file to serve when a directory is requested.
     * @default 'index.html'
     */
    index?: string;
    /**
     * How to handle dotfiles (e.g. .env, .htpasswd).
     * - 'deny'   → 403 Forbidden (default, fail-closed)
     * - 'ignore' → 404 Not Found
     * - 'allow'  → serve normally
     * @default 'deny'
     */
    dotfiles?: 'deny' | 'ignore' | 'allow';
}

/**
 * Maps file extensions to their correct Content-Type header values.
 * Falls back to 'application/octet-stream' for unknown extensions.
 */
const MIME_TYPES: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.htm':  'text/html; charset=utf-8',
    '.css':  'text/css; charset=utf-8',
    '.js':   'application/javascript',
    '.mjs':  'application/javascript',
    '.json': 'application/json',
    '.txt':  'text/plain; charset=utf-8',
    '.xml':  'application/xml',
    '.svg':  'image/svg+xml',
    '.png':  'image/png',
    '.jpg':  'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif':  'image/gif',
    '.webp': 'image/webp',
    '.ico':  'image/x-icon',
    '.woff': 'font/woff',
    '.woff2':'font/woff2',
    '.ttf':  'font/ttf',
    '.pdf':  'application/pdf',
    '.mp4':  'video/mp4',
    '.webm': 'video/webm',
};

/**
 * Resolves the MIME type for a given file path.
 */
export function getMimeType(filePath: string): string {
    const ext = path.extname(filePath).toLowerCase();
    return MIME_TYPES[ext] ?? 'application/octet-stream';
}

/**
 * Generates a deterministic ETag from file size and last-modified time.
 * Format: W/"<md5-of-mtime+size>"
 */
export function generateETag(mtime: Date, size: number): string {
    const raw = `${mtime.getTime()}-${size}`;
    const hash = crypto.createHash('md5').update(raw).digest('hex');
    return `W/"${hash}"`;
}

/**
 * Serves a static file directory over HTTP.
 * Returns a RouteGroup that can be passed directly to server.register().
 *
 * @param mountPath - The URL prefix to serve files under (e.g. '/public')
 * @param rootDir   - The filesystem directory to serve from (e.g. './static')
 * @param options   - StaticOptions for cache, index file, and dotfile handling
 */
export function serveStatic(mountPath: string, rootDir: string, options: StaticOptions = {}): RouteGroup {
    const resolvedRoot = path.resolve(rootDir);
    const maxAge = options.maxAge ?? 86400;
    const indexFile = options.index ?? 'index.html';
    const dotfiles = options.dotfiles ?? 'deny';

    // Normalize the mount path: strip trailing slash
    const cleanMount = mountPath.replace(/\/+$/, '');

    const handler = async (ctx: Context): Promise<symbol> => {
        const rawUrl = ctx.req.url || /* c8 ignore next */ '/';
        // Strip query string
        const urlPath = rawUrl.split('?')[0];

        // Strip the mount prefix to get the relative file path
        let relativePath = urlPath.slice(cleanMount.length) || /* c8 ignore next */ '/';
        /* c8 ignore next */
        if (!relativePath.startsWith('/')) relativePath = '/' + relativePath;

        // --- 1. DIRECTORY TRAVERSAL DEFENSE ---
        // Resolve the absolute path and verify it stays inside resolvedRoot
        const absolutePath = path.resolve(resolvedRoot, '.' + relativePath);
        if (!absolutePath.startsWith(resolvedRoot + path.sep) && absolutePath !== resolvedRoot) {
            ctx.res.statusCode = 403;
            ctx.res.setHeader('Content-Type', 'application/json');
            ctx.res.end(JSON.stringify({ error: 'Forbidden' }));
            return CONTINUE_PIPELINE;
        }

        // --- 2. DOTFILE PROTECTION ---
        // Check every path segment — attacker could hide a dotfile in a subdirectory
        const segments = relativePath.split('/');
        const hasDotfile = segments.some(seg => seg.startsWith('.') && seg.length > 1);
        if (hasDotfile) {
            if (dotfiles === 'deny') {
                ctx.res.statusCode = 403;
                ctx.res.setHeader('Content-Type', 'application/json');
                ctx.res.end(JSON.stringify({ error: 'Forbidden' }));
                return CONTINUE_PIPELINE;
            }
            if (dotfiles === 'ignore') {
                ctx.res.statusCode = 404;
                ctx.res.setHeader('Content-Type', 'application/json');
                ctx.res.end(JSON.stringify({ error: 'Not Found' }));
                return CONTINUE_PIPELINE;
            }
            // 'allow' falls through
        }

        // --- 3. STAT THE FILE ---
        let stat: fs.Stats;
        let filePath = absolutePath;

        try {
            stat = await fs.promises.stat(filePath);
        } catch {
            ctx.res.statusCode = 404;
            ctx.res.setHeader('Content-Type', 'application/json');
            ctx.res.end(JSON.stringify({ error: 'Not Found' }));
            return CONTINUE_PIPELINE;
        }

        // If it's a directory, look for the index file inside
        if (stat.isDirectory()) {
            filePath = path.join(filePath, indexFile);
            try {
                stat = await fs.promises.stat(filePath);
            } catch {
                // No index file — refuse to list the directory
                ctx.res.statusCode = 403;
                ctx.res.setHeader('Content-Type', 'application/json');
                ctx.res.end(JSON.stringify({ error: 'Forbidden: Directory listing not allowed' }));
                return CONTINUE_PIPELINE;
            }
        }

        // --- 4. ETAG + CONDITIONAL GET (304 Not Modified) ---
        const etag = generateETag(stat.mtime, stat.size);
        const clientETag = ctx.req.headers['if-none-match'];
        if (clientETag && clientETag === etag) {
            ctx.res.statusCode = 304;
            ctx.res.end();
            return CONTINUE_PIPELINE;
        }

        // --- 5. SET RESPONSE HEADERS ---
        const mimeType = getMimeType(filePath);
        ctx.res.statusCode = 200;
        ctx.res.setHeader('ETag', etag);
        ctx.res.setHeader('Last-Modified', stat.mtime.toUTCString());
        ctx.res.setHeader('Cache-Control', `public, max-age=${maxAge}`);

        // --- 6. STREAM THE FILE ---
        // Native stream handles Content-Type, Content-Length, Pipeline Locking, and Mid-Stream errors
        const stream = fs.createReadStream(filePath);
        return ctx.stream(stream, mimeType, stat.size);
    };

    // Register as a wildcard GET route under the mount path
    return [{
        method: 'GET',
        path: `${cleanMount}/*`,
        middlewares: [],
        handler
    }];
}
