import { RouteDefinition } from './composition.js';
import * as path from 'node:path';

class RadixNode {
    children: RadixNode[] = [];
    isEnd: boolean = false;
    route?: RouteDefinition;
    
    // For sorting: Static=100, Param=50, Wildcard=0
    score: number = 0; 

    constructor(
        public part: string,
        public isParam: boolean,
        public isWildcard: boolean
    ) {
        if (isWildcard) this.score = 0;
        else if (isParam) this.score = 50;
        else this.score = 100;
    }

    insert(parts: string[], route: RouteDefinition, index: number = 0) {
        if (index === parts.length) {
            this.isEnd = true;
            this.route = route;
            return;
        }

        const part = parts[index];
        const isParam = part.startsWith(':');
        const isWildcard = part === '*';

        let child = this.children.find(c => c.part === part);
        if (!child) {
            child = new RadixNode(part, isParam, isWildcard);
            this.children.push(child);
            // Sort children by score descending so static is always checked before param
            this.children.sort((a, b) => b.score - a.score);
        }

        child.insert(parts, route, index + 1);
    }

    search(parts: string[], index: number = 0): { route?: RouteDefinition, params: Record<string, string> } | null {
        if (index === parts.length) {
            if (this.isEnd) return { route: this.route, params: {} };
            return null;
        }

        const part = parts[index];

        for (const child of this.children) {
            if (child.isWildcard) {
                // Matches everything remaining
                return { route: child.route, params: {} };
            }

            if (child.isParam || child.part === part) {
                const result = child.search(parts, index + 1);
                if (result) {
                    if (child.isParam) {
                        result.params[child.part.substring(1)] = part;
                    }
                    return result;
                }
            }
        }

        return null;
    }
}

export class Router {
    // Trees per HTTP Method
    private trees: Record<string, RadixNode> = {};

    constructor() {
        const methods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'];
        for (const m of methods) {
            this.trees[m] = new RadixNode('', false, false);
        }
    }

    private normalize(p: string): string {
        // Use Node's POSIX path normalizer to safely resolve .. and . without OS bugs
        let clean = path.posix.normalize(p).replace(/\/+$/, '');
        if (!clean || clean === '') clean = '/';
        return clean;
    }

    register(routes: RouteDefinition[]) {
        for (const route of routes) {
            const method = route.method.toUpperCase();
            if (!this.trees[method]) continue;

            const normalizedPath = this.normalize(route.path);
            
            // Split by / and remove empty parts
            const parts = normalizedPath.split('/').filter(p => p.length > 0);
            
            this.trees[method].insert(parts, route);
        }
    }

    find(method: string, path: string): { route?: RouteDefinition, params: Record<string, string> } | null {
        const m = method.toUpperCase();
        if (!this.trees[m]) return null;

        const normalizedPath = this.normalize(path);
        const parts = normalizedPath.split('/').filter(p => p.length > 0);
        
        // BUG-64 FIX: Limit recursion depth to prevent Stack Overflow DoS
        if (parts.length > 100) return null;

        return this.trees[m].search(parts);
    }
}
