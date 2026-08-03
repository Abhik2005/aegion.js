import { Server } from '../src/server.js';
import { group, get, post } from '../src/composition.js';
import { Context, CONTINUE_PIPELINE } from '../src/context.js';
import { SessionManager } from '../src/session.js';
import { CookieManager } from '../src/cookie.js';
import { jwt } from '../src/security/jwt.js';

// Setup Server with Production-grade configuration
const server = new Server({
    port: 3000,
    nosqlSanitizer: true,
    cors: {
        origin: '*',
        methods: ['GET', 'POST', 'PUT', 'DELETE'],
        maxAge: 86400
    },
    rateLimit: {
        windowMs: 15 * 60 * 1000,
        maxRequests: 100000 // Set high enough to not block the benchmark, but enforce the overhead
    },
    cookieSecret: 'super-secret-production-key-that-is-at-least-32-chars-long!'
});

// A dummy middleware to simulate some async work (e.g., db lookup, authentication)
const simulateAuthMiddleware = async (ctx: Context) => {
    // Quick session check simulation
    const cookieMgr = new CookieManager(ctx.req, ctx.res);
    const sessionMgr = new SessionManager(cookieMgr, 'super-secret-production-key-that-is-at-least-32-chars-long!');
    ctx.locals.session = sessionMgr.get();
    return CONTINUE_PIPELINE;
};

const routes = group('/api', [
    // 1. Raw routing throughput (No extra middleware)
    get('/health', async (ctx: Context) => {
        ctx.res.setHeader('Content-Type', 'application/json');
        ctx.res.end(JSON.stringify({ status: 'ok' }));
    }),

    // 2. Dynamic parameter extraction
    get('/users/:id', async (ctx: Context) => {
        const id = ctx.params?.id;
        ctx.res.setHeader('Content-Type', 'application/json');
        ctx.res.end(JSON.stringify({ user: id, name: 'Test User' }));
    }),

    // 3. JSON parsing and JWT Session creation overhead
    post('/auth/login', async (ctx: Context) => {
        const body = await ctx.body();
        
        const cookieMgr = new CookieManager(ctx.req, ctx.res);
        const sessionMgr = new SessionManager(cookieMgr, 'super-secret-production-key-that-is-at-least-32-chars-long!');
        
        sessionMgr.create({ userId: 123, role: 'user' });

        ctx.res.setHeader('Content-Type', 'application/json');
        ctx.res.end(JSON.stringify({ success: true }));
    }),

    // 4. Large deeply nested JSON payload (NoSQL Sanitizer Stress Test)
    post('/search', async (ctx: Context) => {
        const body = await ctx.body();
        ctx.res.setHeader('Content-Type', 'application/json');
        ctx.res.end(JSON.stringify({ results: 42 }));
    })
], [simulateAuthMiddleware]);

server.register(routes);

// Export for runner
export { server };
