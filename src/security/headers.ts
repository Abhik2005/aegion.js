import * as http from 'node:http';

export function applySecurityHeaders(res: http.ServerResponse) {
    // Prevent MIME-sniffing
    res.setHeader('X-Content-Type-Options', 'nosniff');
    
    // Prevent Clickjacking
    res.setHeader('X-Frame-Options', 'DENY');
    
    // XSS Protection for older browsers
    res.setHeader('X-XSS-Protection', '1; mode=block');
    
    // Force HTTPS (HSTS) - 1 year
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    
    // Minimal CSP (Content Security Policy) fallback
    if (!res.hasHeader('Content-Security-Policy')) {
        res.setHeader('Content-Security-Policy', "default-src 'self'");
    }
}
