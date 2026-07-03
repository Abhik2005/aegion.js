import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ViewOptions } from './server.js';

export interface TemplateEngineOptions {
    /**
     * Control template compile caching.
     * - true      → always cache (force production mode)
     * - false     → never cache (force development mode)
     * - undefined → auto-detect: 'production' NODE_ENV = ON, anything else = OFF
     */
    cache?: boolean;
    /**
     * Custom helper functions injected automatically into every template's scope.
     * Available directly by name: {{ formatDate(user.createdAt) }}
     */
    helpers?: Record<string, (...args: any[]) => any>;
}

/**
 * BUG-44 FIX: The module-level compileCache has been removed from the hot path.
 * Each templateEngine() call now gets its own per-instance cache Map, preventing
 * two Server instances with different view dirs from sharing (and corrupting) each other's cache.
 *
 * All active instance caches are registered in this Set so that clearTemplateCache()
 * can clear them all in one call (e.g., during testing or hot-reload scenarios).
 */
const moduleCompileCache = new Map<string, Function>();
const allInstanceCaches = new Set<Map<string, Function>>();

/**
 * Escapes the 6 characters that can enable XSS attacks into safe HTML entities.
 * Called automatically for every {{ expr }} tag.
 * null and undefined are safely coerced to empty string before escaping.
 */
export function escapeHtml(value: any): string {
    const str = String(value ?? '');
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#x27;')
        .replace(/\//g, '&#x2F;');
}

/**
 * Parses a template string into a JavaScript async function body string.
 *
 * Tag types handled (in priority order to avoid misidentification):
 *  {{{ expr }}}           → unescaped raw HTML output
 *  {{ include('f.html') }} → async partial include
 *  {{ expr }}             → XSS-escaped output
 *  {% code %}             → raw JS code block (if, for, while, etc.)
 *  {# comment #}          → stripped completely — zero output
 *  (plain text)           → emitted via JSON.stringify for safe JS string encoding
 */
export function parse(source: string): string {
    // Regex splits the source into alternating plain-text and tag segments.
    // {{{ before {{ is critical — prevents the triple-brace tag being mis-tokenized.
    const TOKEN_RE = /(\{\{\{[\s\S]*?\}\}\}|\{\{[\s\S]*?\}\}|\{%[\s\S]*?%\}|\{#[\s\S]*?#\})/g;
    const parts = source.split(TOKEN_RE);
    let body = '';

    for (const part of parts) {
        if (!part) continue;

        if (part.startsWith('{{{') && part.endsWith('}}}')) {
            // {{{ expr }}} — unescaped raw HTML. Developer's explicit responsibility.
            const expr = part.slice(3, -3).trim();
            body += `__out += String((${expr}) ?? '');\n`;

        } else if (part.startsWith('{{') && part.endsWith('}}')) {
            const expr = part.slice(2, -2).trim();

            // Check for {{ include('partial.html') }} syntax
            const includeMatch = /^include\s*\(\s*(["'`])(.*?)\1\s*\)$/.exec(expr);
            if (includeMatch) {
                // Emit an async include call — resolved at runtime by __include
                body += `__out += await __include(${JSON.stringify(includeMatch[2])});\n`;
            } else {
                // {{ expr }} — auto-escaped output (XSS safe by default)
                body += `__out += __escape((${expr}));\n`;
            }

        } else if (part.startsWith('{%') && part.endsWith('%}')) {
            // {% code %} — raw JavaScript. Emitted directly into function body.
            const code = part.slice(2, -2).trim();
            body += `${code}\n`;

        } else if (part.startsWith('{#') && part.endsWith('#}')) {
            // {# comment #} — discarded entirely. No output.

        } else {
            // Plain text — JSON.stringify safely encodes newlines, quotes, backslashes.
            body += `__out += ${JSON.stringify(part)};\n`;
        }
    }

    return body;
}

/**
 * Compiles a template source string into an executable async function.
 *
 * Uses new AsyncFunction() — the universal technique used by EJS, Pug, and Handlebars.
 * The with(__data) statement makes data properties and helpers directly accessible
 * by name inside templates: {{ user.name }} instead of {{ __data.user.name }}.
 * Note: with() requires non-strict mode, which is intentional for template compilation.
 */
export function compile(source: string): Function {
    const body = parse(source);
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    return new AsyncFunction(
        '__data', '__escape', '__include',
        `with (__data) {\n  let __out = '';\n${body}  return __out;\n}`
    );
}

/**
 * Core render function.
 * Reads template file → compiles to function (respecting cache) → executes with data.
 * Handles include resolution with directory traversal protection.
 *
 * BUG-44 FIX: Accepts an explicit instanceCache parameter so each templateEngine()
 * instance uses its own isolated Map instead of the shared module-level cache.
 */
async function render(
    filePath: string,
    data: Record<string, any>,
    viewsDir: string,
    options: TemplateEngineOptions,
    instanceCache: Map<string, Function>
): Promise<string> {
    const shouldCache = options.cache ?? (process.env.NODE_ENV === 'production');

    // --- Get or compile the template function ---
    let compiled: Function;
    if (shouldCache && instanceCache.has(filePath)) {
        compiled = instanceCache.get(filePath)!;
    } else {
        let source: string;
        try {
            source = await fs.promises.readFile(filePath, 'utf-8');
        } catch {
            throw new Error(`[AegionTemplate] Template not found: ${filePath}`);
        }
        compiled = compile(source);
        if (shouldCache) {
            instanceCache.set(filePath, compiled);
        }
    }

    // --- Merge helpers + data. Data takes priority over helpers. ---
    // Wrap in a Proxy so accessing undefined template variables returns undefined
    // instead of throwing ReferenceError inside the with() block.
    // The has() trap must NOT intercept:
    //   - Internal vars (__escape, __include) — they are function parameters, not data
    //   - Global built-ins (String, Number, Boolean, etc.) — fall through to globalThis
    const SAFE_GLOBALS = new Set([
        'String', 'Number', 'Boolean', 'Array', 'Object', 'Function',
        'Math', 'JSON', 'Date', 'RegExp', 'Map', 'Set', 'WeakMap', 'WeakSet',
        'Promise', 'Error', 'TypeError', 'SyntaxError', 'RangeError',
        'console', 'parseInt', 'parseFloat', 'isNaN', 'isFinite',
        'decodeURI', 'decodeURIComponent', 'encodeURI', 'encodeURIComponent'
    ]);

    const merged = { ...(options.helpers ?? {}), ...data };
    const __data = new Proxy(merged, {
        has: (target, key) => {
            /* c8 ignore start */
            if (typeof key !== 'string') {
                return false;
            }
            /* c8 ignore stop */
            if (key.startsWith('__')) return false;    // Don't shadow __escape/__include
            if (SAFE_GLOBALS.has(key)) return false;   // Allow safe globals
            return true;                               // Shadow everything else (process, require, global, etc)
        },
        get: (target, key) => {
            /* c8 ignore next */
            if (key === 'constructor' || key === '__proto__') return undefined; // Block prototype climbing
            return (target as any)[key];
        }
    });

    // --- Include resolver: injected into every compiled template ---
    const __include = async (relPath: string): Promise<string> => {
        const partialPath = path.resolve(viewsDir, relPath);
        // Security: partial must stay strictly inside the views directory.
        // Same directory traversal defense as serveStatic.
        if (
            !partialPath.startsWith(viewsDir + path.sep) &&
            partialPath !== viewsDir
        ) {
            throw new Error(
                `[AegionTemplate] Security: include "${relPath}" escapes views directory`
            );
        }
        return render(partialPath, data, viewsDir, options, instanceCache);
    };

    try {
        return await compiled(__data, escapeHtml, __include);
    } catch (err: any) {
        // Re-throw AegionTemplate errors (security, not-found, nested includes) as-is
        if (err instanceof Error && err.message.startsWith('[AegionTemplate]')) throw err;
        /* c8 ignore next */
        throw new Error(`[AegionTemplate] Render error in ${filePath}: ${(err as any)?.message ?? err}`);
    }
}

/**
 * Creates an Aegion-compatible template engine.
 * Returns a ViewOptions object that plugs directly into ServerOptions.views.
 *
 * BUG-44 FIX: Each call to templateEngine() creates its own isolated compile cache.
 * Previously the cache was module-level, meaning two Server instances with different
 * view directories could corrupt each other's cache if template filenames collided.
 *
 * Zero new API on Server — the existing ViewOptions interface handles everything.
 *
 * @param dir     - Directory where .html/.ejs template files are stored (e.g. './views')
 * @param options - Cache strategy and custom helper functions
 *
 * @example
 * import { Server, templateEngine } from 'aegion';
 *
 * const app = new Server({
 *     views: templateEngine('./views', {
 *         helpers: {
 *             capitalize: (s: string) => s[0].toUpperCase() + s.slice(1),
 *             formatDate:  (d: Date)   => d.toLocaleDateString()
 *         }
 *     })
 * });
 *
 * // In route handler:
 * ctx.render('home.html', { user: { name: 'vedad' } });
 */
export function templateEngine(dir: string, options: TemplateEngineOptions = {}): ViewOptions {
    const resolvedDir = path.resolve(dir.replace(/\/+$/, ''));
    // BUG-44 FIX: Per-instance cache — each Server gets its own isolated Map.
    const instanceCache = new Map<string, Function>();
    // Register with the global set so clearTemplateCache() can flush all instances.
    allInstanceCaches.add(instanceCache);

    return {
        engine: (filePath: string, data?: any) => {
            const renderData = data || /* c8 ignore next */ {};
            return render(filePath, renderData, resolvedDir, options, instanceCache);
        },
        dir: resolvedDir
    };
}

/**
 * Clears ALL template compile caches:
 *  - The module-level cache used by direct compile() callers
 *  - Every per-instance cache created by templateEngine() calls
 *
 * Use in tests or when you need to force template recompilation across the board.
 */
export function clearTemplateCache(): void {
    moduleCompileCache.clear();
    for (const cache of allInstanceCaches) {
        cache.clear();
    }
}
