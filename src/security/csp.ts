import * as crypto from 'node:crypto';
import { Context } from '../context.js';

export interface CspDirectives {
    defaultSrc?: string[];
    scriptSrc?: string[];
    styleSrc?: string[];
    imgSrc?: string[];
    connectSrc?: string[];
    fontSrc?: string[];
    objectSrc?: string[];
    mediaSrc?: string[];
    frameSrc?: string[];
    sandbox?: string[];
    reportUri?: string;
    childSrc?: string[];
    formAction?: string[];
    frameAncestors?: string[];
    pluginTypes?: string[];
    baseUri?: string[];
    reportTo?: string;
    workerSrc?: string[];
    manifestSrc?: string[];
    prefetchSrc?: string[];
    navigateTo?: string[];
}

export interface CspOptions {
    /**
     * Set to true to use Content-Security-Policy-Report-Only header instead.
     * This will not block assets, but will send reports to the specified reportUri.
     */
    reportOnly?: boolean;
    
    /**
     * Map of CSP directives. If undefined, defaults to strictly `default-src 'self'`.
     */
    directives?: CspDirectives;
    
    /**
     * If true, generates a cryptographically secure nonce for every request
     * and attaches it to `ctx.locals.nonce`. It will also automatically inject
     * `'nonce-{nonce}'` into the scriptSrc and styleSrc directives.
     * Default is true.
     */
    useNonce?: boolean;
}

const DEFAULT_DIRECTIVES: CspDirectives = {
    defaultSrc: ["'self'"]
};

// CamelCase to kebab-case map for fast lookup
const DIRECTIVE_MAP: Record<keyof CspDirectives, string> = {
    defaultSrc: 'default-src',
    scriptSrc: 'script-src',
    styleSrc: 'style-src',
    imgSrc: 'img-src',
    connectSrc: 'connect-src',
    fontSrc: 'font-src',
    objectSrc: 'object-src',
    mediaSrc: 'media-src',
    frameSrc: 'frame-src',
    sandbox: 'sandbox',
    reportUri: 'report-uri',
    childSrc: 'child-src',
    formAction: 'form-action',
    frameAncestors: 'frame-ancestors',
    pluginTypes: 'plugin-types',
    baseUri: 'base-uri',
    reportTo: 'report-to',
    workerSrc: 'worker-src',
    manifestSrc: 'manifest-src',
    prefetchSrc: 'prefetch-src',
    navigateTo: 'navigate-to'
};

/**
 * Military-grade Content Security Policy (CSP) engine.
 * Protects against Cross-Site Scripting (XSS) by whitelisting trusted domains.
 */
export function csp(options: CspOptions = {}) {
    const isReportOnly = !!options.reportOnly;
    const headerName = isReportOnly ? 'Content-Security-Policy-Report-Only' : 'Content-Security-Policy';
    const useNonce = options.useNonce !== false; // Default true
    
    // We pre-calculate static directives to avoid looping on every request
    // if nonce is disabled. But if nonce is enabled, we MUST rebuild script/style tags per request.
    const rawDirectives = options.directives || DEFAULT_DIRECTIVES;
    
    // Build a clean map of requested directives
    const directiveEntries = Object.entries(rawDirectives) as [keyof CspDirectives, string[] | string][];

    return async (ctx: Context) => {
        let nonceString = '';
        
        if (useNonce) {
            // Generate a 128-bit cryptographically secure random base64 string
            const nonce = crypto.randomBytes(16).toString('base64');
            ctx.locals.nonce = nonce;
            nonceString = `'nonce-${nonce}'`;
        }

        const policyChunks: string[] = [];

        for (const [key, value] of directiveEntries) {
            const kebabKey = DIRECTIVE_MAP[key];
            /* c8 ignore next 1 */
            if (!kebabKey) continue;
            
            // Format the directive values
            let formattedValues = '';
            
            if (Array.isArray(value)) {
                const values = [...value]; // clone so we don't mutate global options
                
                // Automatically inject the nonce into script-src and style-src if missing
                if (useNonce && (key === 'scriptSrc' || key === 'styleSrc')) {
                    values.push(nonceString);
                }
                
                formattedValues = values.join(' ');
            } else {
                formattedValues = value as string;
            }
            
            policyChunks.push(`${kebabKey} ${formattedValues}`);
        }
        
        // Edge case: if they enabled nonce, but didn't specify scriptSrc or styleSrc, 
        // we should explicitly attach it to scriptSrc to ensure inline scripts work if they want them to.
        if (useNonce && !rawDirectives.scriptSrc) {
            // If default-src is defined, we inherit from it, but append the nonce
            /* c8 ignore next */
            const defaultSrc = rawDirectives.defaultSrc ? (Array.isArray(rawDirectives.defaultSrc) ? rawDirectives.defaultSrc.join(' ') : rawDirectives.defaultSrc) : "'self'";
            policyChunks.push(`script-src ${defaultSrc} ${nonceString}`);
        }

        const policyString = policyChunks.join('; ');
        ctx.res.setHeader(headerName, policyString);
        
        return ctx.next();
    };
}
