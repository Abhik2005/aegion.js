import * as net from 'node:net';
import { Server, group, get, Middleware, Context } from '../src/index';

const PORT = 3006;
const app = new Server({ port: PORT });

// 1. Generate 100,000 routes to stress the Radix Tree
console.log("Generating 100,000 static routes...");
const massiveRoutes = [];
for (let i = 0; i < 100000; i++) {
    massiveRoutes.push(get(`/static/route/number/is/${i}`, async (ctx) => ctx.json({ id: i })));
}
app.register(group('/api', ...massiveRoutes));

// 2. Deep Dynamic Nesting
console.log("Generating deeply nested dynamic route...");
let deepPath = '/api/deep';
for (let i = 0; i < 100; i++) {
    deepPath += `/:param${i}`;
}
app.register(get(deepPath, async (ctx) => ctx.json({ depth: 100, params: ctx.req.params })));

// 3. Massive Middleware Chain (1,000 middlewares)
console.log("Generating massive middleware chain...");
const middlewares: Middleware[] = [];
for (let i = 0; i < 1000; i++) {
    middlewares.push(async (ctx: Context, next: Function) => {
        ctx.req.headers[`x-middleware-chain-${i}`] = 'passed';
        await next();
    });
}
app.register(group('/middleware', ...middlewares, get('/chain', async (ctx) => ctx.json({ success: true }))));

// 4. Overlapping and Unicode Wildcards
app.register(
    get('/api/*', async (ctx) => ctx.json({ wildcard: 'api' })),
    get('/api/v1/*', async (ctx) => ctx.json({ wildcard: 'v1' })),
    get('/😀/🚀/*', async (ctx) => ctx.json({ emoji: true }))
);

function sendRawTCP(payload: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const client = net.createConnection({ port: PORT, host: '127.0.0.1' }, () => {
            client.write(payload);
        });
        let data = '';
        client.on('data', (chunk) => {
            data += chunk.toString();
        });
        client.on('end', () => {
            resolve(data);
        });
        client.on('error', (err) => {
            reject(err);
        });
    });
}

async function simulate() {
    console.log("=========================================");
    console.log("🛡️ AEGION SECURITY LAB: EXTREME ROUTING");
    console.log("=========================================\n");

    // Scenario 1: Radix Tree Lookup Speed on 100k Routes
    console.log("--- SCENARIO 1: RADIX TREE LOOKUP (100k ROUTES) ---");
    const start = process.hrtime.bigint();
    const res1 = await sendRawTCP(`GET /api/static/route/number/is/99999 HTTP/1.1\r\nHost: localhost:${PORT}\r\n\r\n`);
    const end = process.hrtime.bigint();
    if (res1.includes('200 OK')) {
        console.log(`[RESULT] 🟢 SUCCESS! Found route 99999 out of 100,000 routes in ${Number(end - start) / 1e6}ms!\n`);
    }

    // Scenario 2: Deep Dynamic Nesting
    console.log("--- SCENARIO 2: DEEP DYNAMIC NESTING (100 DEPTH) ---");
    let deepUrl = '/api/deep' + '/a'.repeat(100);
    const res2 = await sendRawTCP(`GET ${deepUrl} HTTP/1.1\r\nHost: localhost:${PORT}\r\n\r\n`);
    if (res2.includes('200 OK')) {
        console.log(`[RESULT] 🟢 SUCCESS! Handled 100 deep dynamic parameters perfectly.\n`);
    } else {
        console.log(`[RESULT] 🔴 FAILURE! Node URI length or parser failed. Response: ${res2}\n`);
    }

    // Scenario 3: Call Stack Exhaustion (1000 middlewares)
    console.log("--- SCENARIO 3: CALL STACK EXHAUSTION (1,000 MIDDLEWARES) ---");
    const res3 = await sendRawTCP(`GET /middleware/chain HTTP/1.1\r\nHost: localhost:${PORT}\r\n\r\n`);
    if (res3.includes('200 OK')) {
        console.log(`[RESULT] 🟢 SUCCESS! V8 navigated 1,000 nested async middleware callbacks without call stack size exceeded.\n`);
    } else {
        console.log(`[RESULT] 🔴 FAILURE! Server threw call stack exceeded!\n`);
    }

    // Scenario 4: Path Traversal
    console.log("--- SCENARIO 4: PATH TRAVERSAL DOT-DOT-SLASH ---");
    const res4 = await sendRawTCP(`GET /api/static/../../../../etc/passwd HTTP/1.1\r\nHost: localhost:${PORT}\r\n\r\n`);
    if (res4.includes('400') || res4.includes('404')) {
        console.log(`[RESULT] 🟢 SUCCESS! Server normalized or safely rejected traversal attempts.\n`);
    }

    // Scenario 5: Unicode and Wildcard Overlap
    console.log("--- SCENARIO 5: UNICODE & WILDCARD OVERLAP ---");
    const res5 = await sendRawTCP(`GET /%F0%9F%98%80/%F0%9F%9A%80/anything HTTP/1.1\r\nHost: localhost:${PORT}\r\n\r\n`);
    if (res5.includes('200 OK') && res5.includes('emoji')) {
        console.log(`[RESULT] 🟢 SUCCESS! Server routed decoded Unicode path perfectly into the wildcard boundary.\n`);
    }

    console.log("=========================================");
    console.log("🛡️ EXTREME ROUTING SIMULATION COMPLETE.");
    console.log("=========================================");
    
    if (typeof app !== 'undefined') app.close();;
}

app.start(() => {
    simulate().catch(console.error);
});
