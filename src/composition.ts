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

export const get = (path: string, handler: Handler) => createRoute('GET', path, handler);
export const post = (path: string, handler: Handler) => createRoute('POST', path, handler);
export const put = (path: string, handler: Handler) => createRoute('PUT', path, handler);
export const patch = (path: string, handler: Handler) => createRoute('PATCH', path, handler);
export const del = (path: string, handler: Handler) => createRoute('DELETE', path, handler);
export const options = (path: string, handler: Handler) => createRoute('OPTIONS', path, handler);
export const head = (path: string, handler: Handler) => createRoute('HEAD', path, handler);

/**
 * Groups routes together, prefixing their paths and applying shared middlewares.
 */
export function group(prefix: string, ...args: (Middleware[] | RouteGroup | RouteGroup[])[]): RouteGroup {
    const combined: RouteGroup = [];
    const sharedMiddlewares: Middleware[] = [];

    for (const arg of args) {
        if (Array.isArray(arg)) {
            // Check if it's an array of Middlewares or an array of RouteGroups
            if (arg.length > 0 && typeof arg[0] === 'function') {
                sharedMiddlewares.push(...(arg as Middleware[]));
            } else {
                // Flatten RouteGroups
                const routeGroups = arg as (RouteDefinition | RouteGroup)[];
                for (const item of routeGroups) {
                    if (Array.isArray(item)) {
                        combined.push(...item);
                    } else if (item && typeof item === 'object' && 'method' in item) {
                        combined.push(item);
                    }
                }
            }
        }
    }

    // Apply prefix and middlewares to all combined routes
    return combined.map(route => {
        // Strip trailing slashes safely
        const cleanPrefix = prefix.replace(/\/+$/, '');
        const childPath = route.path.startsWith('/') ? route.path : '/' + route.path;
        let newPath = cleanPrefix + childPath;
        // Ensure path starts with / (in case prefix was empty and childPath was somehow empty)
        if (!newPath.startsWith('/')) newPath = '/' + newPath;

        return {
            ...route,
            path: newPath,
            middlewares: [...sharedMiddlewares, ...route.middlewares]
        };
    });
}
