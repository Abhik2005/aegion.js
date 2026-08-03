import { Context, CONTINUE_PIPELINE } from './context.js';

export type Middleware = (ctx: Context) => Promise<symbol | any> | symbol | any;
export type Handler = (ctx: Context) => Promise<any> | any;
export type ErrorHandler = (err: any, ctx: Context) => Promise<void> | void;

export interface RouteDefinition {
    method: string;
    path: string;
    middlewares: Middleware[];
    handler: Handler;
}

export type RouteGroup = RouteDefinition[];

/**
 * Creates a route definition.
 */
function createRoute(method: string, path: string, handler: Handler): RouteGroup {
    return [{
        method,
        path,
        middlewares: [],
        handler
    }];
}

export const get     = (path: string, handler: Handler) => createRoute('GET',     path, handler);
export const post    = (path: string, handler: Handler) => createRoute('POST',    path, handler);
export const put     = (path: string, handler: Handler) => createRoute('PUT',     path, handler);
export const patch   = (path: string, handler: Handler) => createRoute('PATCH',   path, handler);
export const del     = (path: string, handler: Handler) => createRoute('DELETE',  path, handler);
export const options = (path: string, handler: Handler) => createRoute('OPTIONS', path, handler);
export const head    = (path: string, handler: Handler) => createRoute('HEAD',    path, handler);

/**
 * Returns true if a value is a RouteDefinition object (has 'method', 'path',
 * 'middlewares', and 'handler' own properties).
 * This replaces the fragile duck-type check `typeof arg[0] === 'function'`
 * which silently misclassified empty arrays and arrays of route groups.
 */
function isRouteDefinition(value: unknown): value is RouteDefinition {
    return (
        value !== null &&
        typeof value === 'object' &&
        typeof (value as any).method === 'string' &&
        typeof (value as any).path === 'string' &&
        Array.isArray((value as any).middlewares) &&
        typeof (value as any).handler === 'function'
    );
}

/**
 * Returns true if the value is a Middleware function (a plain function that
 * is NOT a RouteDefinition object).
 */
function isMiddleware(value: unknown): value is Middleware {
    return typeof value === 'function';
}

/**
 * Groups routes together, prefixing their paths and applying shared middlewares.
 *
 * Accepts any mix of:
 *   - Middleware functions (applied to every route in this group)
 *   - RouteGroups (flat arrays of RouteDefinition)
 *   - Arrays of RouteGroups (nested spreads from child group() calls)
 *
 * The fragile old detection (typeof arg[0] === 'function') has been replaced
 * with explicit structural checks via isRouteDefinition() and isMiddleware(),
 * so empty arrays and nested groups are always handled correctly.
 */
export function group(prefix: string, ...args: (Middleware | Middleware[] | RouteGroup | RouteGroup[])[]): RouteGroup {
    const combined: RouteGroup = [];
    const sharedMiddlewares: Middleware[] = [];

    for (const arg of args) {
        if (isMiddleware(arg)) {
            // Single bare middleware function passed directly
            sharedMiddlewares.push(arg);
        } else if (Array.isArray(arg)) {
            // Could be: Middleware[], RouteGroup (RouteDefinition[]), or RouteGroup[] (nested)
            for (const item of arg) {
                if (isMiddleware(item)) {
                    // Array of middleware functions: [mw1, mw2]
                    sharedMiddlewares.push(item);
                } else if (isRouteDefinition(item)) {
                    // Flat RouteGroup: [{ method, path, middlewares, handler }, ...]
                    combined.push(item);
                } else if (Array.isArray(item)) {
                    // Nested RouteGroup[]: result of a child group() call spread into an array
                    for (const nested of item) {
                        if (isRouteDefinition(nested)) {
                            combined.push(nested);
                        }
                    }
                }
            }
        }
    }

    // Apply prefix and middlewares to all collected routes
    return combined.map(route => {
        const cleanPrefix = prefix.replace(/\/+$/, '');
        const childPath = route.path.startsWith('/') ? route.path : '/' + route.path;
        let newPath = cleanPrefix + childPath;
        if (!newPath.startsWith('/')) newPath = '/' + newPath;

        return {
            ...route,
            path: newPath,
            middlewares: [...sharedMiddlewares, ...route.middlewares]
        };
    });
}
