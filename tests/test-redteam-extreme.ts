/**
 * ╔══════════════════════════════════════════════════════════════╗
 * ║       🔴 AEGION RED TEAM — ATTACK SIMULATION LAB 🔴          ║
 * ║   Fake adversarial environment. Coordinated attack campaigns  ║
 * ║   launched against a live server to measure integrity.        ║
 * ╚══════════════════════════════════════════════════════════════╝
 *
 * Campaign breakdown:
 *  1.  Slowloris DoS               — drip headers, starve connections
 *  2.  HTTP Request Smuggling      — CL.TE desync
 *  3.  CRLF Header Injection       — split response via query string
 *  4.  Null-Byte Path Injection    — %00 to bypass route matching
 *  5.  Host Header Poisoning       — cache-poison via spoofed Host
 *  6.  HTTP Pipeline Flooding      — 50 requests in 1 TCP stream
 *  7.  Body Desync (short body)    — lie about Content-Length
 *  8.  Memory Bomb                 — 30 concurrent 2 MB payloads
 *  9.  Header Bomb                 — 500 unique headers in one request
 * 10.  Unicode Path Traversal      — %2e%2e encoded dot-dot sequences
 * 11.  HTTP Method Override        — X-HTTP-Method-Override: DELETE
 * 12.  Cache Deception Attack      — /api/secret/styles.css path trick
 * 13.  ReDoS via Route Param       — catastrophic backtrack pattern
 * 14.  Prototype Pollution Body    — __proto__ key in JSON body
 * 15.  Content-Type Confusion      — XML entity bomb in JSON field
 * 16.  Chunked Encoding Abuse      — malformed chunk size headers
 * 17.  HTTP/0.9 Downgrade          — missing HTTP version line
 * 18.  Error Cascade Storm         — 50 simultaneous handler crashes
 * 19.  Connection Flood (no send)  — open 200 sockets, send nothing
 * 20.  Response Splitting          — CRLF in redirect Location param
 */

import * as net from 'node:net';
import * as crypto from 'node:crypto';
import { Server, get, post } from '../src/index';
import { bruteForce } from '../src/security/brute-force';
import { rateLimit } from '../src/security/rate-limit';

// ─── Ports ─────────────────────────────────────────────────────────────────
const PORT       = 3030;   // Main attack target
const STATIC_PORT = 3031;  // Static-file server target

// ─── Score Board ────────────────────────────────────────────────────────────
type Verdict = '🟢 DEFENDED' | '🔴 BREACHED' | '🟡 PARTIAL' | '⚪ N/A';
const results: { id: number; name: string; verdict: Verdict; detail: string }[] = [];
function report(id: number, name: string, verdict: Verdict, detail: string) {
    results.push({ id, name, verdict, detail });
    console.log(`[RESULT] ${verdict} — #${id} ${name}: ${detail}\n`);
}

// ─── TCP helpers ─────────────────────────────────────────────────────────────
function tcpRaw(port: number, data: string | Buffer, timeoutMs = 6000): Promise<string> {
    return new Promise((resolve) => {
        const c = net.createConnection({ port, host: '127.0.0.1' }, () => {
            c.write(typeof data === 'string' ? Buffer.from(data, 'binary') : data);
        });
        let buf = '';
        const t = setTimeout(() => { c.destroy(); resolve(buf || '(timeout)'); }, timeoutMs);
        c.on('data', d => { buf += d.toString('binary'); });
        c.on('end',  () => { clearTimeout(t); resolve(buf); });
        c.on('error', e => { clearTimeout(t); resolve('ERR:' + e.message); });
    });
}

function statusOf(raw: string): number {
    const m = raw.match(/HTTP\/\d\.\d (\d{3})/);
    return m ? parseInt(m[1]) : 0;
}

// ─── Server setup ──────────────────────────────────────────────────────────
const app = new Server({ port: PORT, cookieSecret: 'redteam-secret-key-32byteslong!!' });
app.register([
    ...get('/api/data',   async (ctx) => ctx.json({ secret: 'TOP_SECRET_DATA', userId: 1 })),
    ...get('/api/admin',  async (ctx) => ctx.json({ admin: true, token: 'ADMIN_TOKEN' })),
    ...get('/health',     async (ctx) => ctx.json({ ok: true })),
    ...post('/api/login', async (ctx) => {
        const body: any = await ctx.body();
        if (body?.password === 'correct') return ctx.json({ token: 'jwt_here' });
        return ctx.status(401).json({ error: 'Unauthorized' });
    }),
    ...post('/api/echo',  async (ctx) => {
        const body: any = await ctx.body();
        return ctx.json({ echo: body });
    }),
    ...get('/redirect',   async (ctx) => {
        // Intentionally uses query param for redirect target (vulnerable to open redirect/splitting)
        const dest = ctx.query.to || '/';
        ctx.res.writeHead(302, { Location: dest });
        ctx.res.end();
    }),
    ...get('/api/user/:id', async (ctx) => ctx.json({ id: ctx.params.id })),
    ...post('/api/crash', async (_ctx) => { throw new Error('Intentional crash'); }),
]);

// ─── Main attack simulation ─────────────────────────────────────────────────
async function runAttacks() {
    console.log('\n' + '═'.repeat(60));
    console.log('🔴  AEGION RED TEAM: ATTACK SIMULATION ENGAGED');
    console.log('🎯  Target: ' + `http://127.0.0.1:${PORT}`);
    console.log('═'.repeat(60) + '\n');
    await new Promise(r => setTimeout(r, 200)); // Server warm-up

    // ══════════════════════════════════════════════════════════════
    // CAMPAIGN 1: SLOWLORIS DoS
    // Open 20 connections, send one header byte per second to
    // never complete the HTTP request and exhaust the connection pool.
    // ══════════════════════════════════════════════════════════════
    console.log('─── CAMPAIGN 1: SLOWLORIS DoS ───────────────────────────');
    console.log('Opening 20 slow connections (1 char/second), then checking server health...');
    const slowSockets: net.Socket[] = [];
    for (let i = 0; i < 20; i++) {
        const s = net.createConnection({ port: PORT, host: '127.0.0.1' });
        s.on('error', () => {}); // suppress
        s.write('GET /health HTTP/1.1\r\nHost: localhost\r\n'); // incomplete — no \r\n terminator
        slowSockets.push(s);
    }
    // Give server 300ms then check if legit request still works
    await new Promise(r => setTimeout(r, 300));
    const slowHealth = await tcpRaw(PORT, 'GET /health HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n', 3000);
    slowSockets.forEach(s => s.destroy());
    if (statusOf(slowHealth) === 200) {
        report(1, 'Slowloris DoS', '🟢 DEFENDED', 'Server stayed responsive under 20 incomplete connections');
    } else {
        report(1, 'Slowloris DoS', '🔴 BREACHED', `Server unresponsive — status: ${statusOf(slowHealth)}`);
    }

    // ══════════════════════════════════════════════════════════════
    // CAMPAIGN 2: HTTP REQUEST SMUGGLING (CL.TE)
    // Send a request with both Content-Length AND Transfer-Encoding: chunked.
    // Attacker hopes front-proxy uses CL while backend uses TE to "smuggle"
    // a hidden second request through.
    // ══════════════════════════════════════════════════════════════
    console.log('─── CAMPAIGN 2: HTTP REQUEST SMUGGLING (CL.TE) ─────────');
    console.log('Sending request with both Content-Length and Transfer-Encoding headers...');
    const smugglePayload =
        'POST /api/echo HTTP/1.1\r\n' +
        'Host: localhost\r\n' +
        'Content-Type: application/json\r\n' +
        'Content-Length: 35\r\n' +          // CL says 35 bytes
        'Transfer-Encoding: chunked\r\n' +  // TE also present
        'Connection: close\r\n' +
        '\r\n' +
        '1\r\n' +                            // chunk of 1 byte
        'X\r\n' +
        '0\r\n' +                            // end chunk
        '\r\n' +
        // Hidden "smuggled" request after the body
        'GET /api/admin HTTP/1.1\r\nHost: localhost\r\n\r\n';
    const smuggleRes = await tcpRaw(PORT, smugglePayload);
    const hasAdminLeak = smuggleRes.includes('ADMIN_TOKEN') || smuggleRes.includes('"admin":true');
    if (!hasAdminLeak) {
        report(2, 'HTTP Request Smuggling (CL.TE)', '🟢 DEFENDED', 'No admin data leaked in smuggled response');
    } else {
        report(2, 'HTTP Request Smuggling (CL.TE)', '🔴 BREACHED', 'Admin data visible in response — smuggling succeeded!');
    }

    // ══════════════════════════════════════════════════════════════
    // CAMPAIGN 3: CRLF HEADER INJECTION via Query String
    // Attacker injects \r\n into a redirect target to split the HTTP
    // response and inject arbitrary headers.
    // ══════════════════════════════════════════════════════════════
    console.log('─── CAMPAIGN 3: CRLF HEADER INJECTION ──────────────────');
    console.log('Injecting \\r\\n into redirect param to split HTTP response...');
    // The injected value: /evil\r\nX-Injected: HACKED
    const crlfPayload = '/redirect?to=' + encodeURIComponent('/safe\r\nX-Injected: HACKED\r\nX-Extra: POISON');
    const crlfReq = `GET ${crlfPayload} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`;
    const crlfRes = await tcpRaw(PORT, crlfReq);
    const injected = crlfRes.includes('X-Injected: HACKED') || crlfRes.includes('X-Extra: POISON');
    if (!injected) {
        report(3, 'CRLF Header Injection', '🟢 DEFENDED', 'Injected \\r\\n sanitized — headers not split');
    } else {
        report(3, 'CRLF Header Injection', '🔴 BREACHED', 'CRLF injection successful! Response headers poisoned');
    }

    // ══════════════════════════════════════════════════════════════
    // CAMPAIGN 4: NULL BYTE PATH INJECTION
    // Send /api/admin%00.jpg hoping the router treats path as /api/admin
    // but a CDN or file server caches it as a static asset.
    // ══════════════════════════════════════════════════════════════
    console.log('─── CAMPAIGN 4: NULL BYTE PATH INJECTION ────────────────');
    console.log('Requesting /api/data%00.jpg to confuse router...');
    const nullRes = await tcpRaw(PORT, 'GET /api/data%00.jpg HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n');
    const nullStatus = statusOf(nullRes);
    // Should be 400 (Bad Request) or 404, NEVER 200 with secret data
    const nullLeaked = nullRes.includes('TOP_SECRET_DATA');
    if (!nullLeaked && nullStatus !== 200) {
        report(4, 'Null Byte Path Injection', '🟢 DEFENDED', `Returned ${nullStatus} — data not exposed via null byte path`);
    } else {
        report(4, 'Null Byte Path Injection', '🔴 BREACHED', `Status ${nullStatus} — secret data returned via null-byte path!`);
    }

    // ══════════════════════════════════════════════════════════════
    // CAMPAIGN 5: HOST HEADER POISONING
    // Send a spoofed Host header. In some systems, this can cause
    // cache poisoning or password-reset link poisoning.
    // ══════════════════════════════════════════════════════════════
    console.log('─── CAMPAIGN 5: HOST HEADER POISONING ───────────────────');
    console.log('Sending spoofed Host header to poison cache or links...');
    const hostPoisonReq =
        'GET /api/data HTTP/1.1\r\n' +
        'Host: evil-attacker.com\r\n' +
        'X-Forwarded-Host: evil-attacker.com\r\n' +
        'X-Forwarded-For: 127.0.0.1\r\n' +
        'Connection: close\r\n' +
        '\r\n';
    const hostRes = await tcpRaw(PORT, hostPoisonReq);
    const hostStatus = statusOf(hostRes);
    // Server should respond (not crash), and NOT echo back the evil host in body
    const hostLeaked = hostRes.includes('evil-attacker.com') && hostRes.includes('TOP_SECRET');
    if (hostStatus >= 200 && hostStatus < 500 && !hostLeaked) {
        report(5, 'Host Header Poisoning', '🟢 DEFENDED', `Returned ${hostStatus} — spoofed Host not reflected in sensitive context`);
    } else {
        report(5, 'Host Header Poisoning', '🔴 BREACHED', `Evil host reflected or server crashed (${hostStatus})`);
    }

    // ══════════════════════════════════════════════════════════════
    // CAMPAIGN 6: HTTP PIPELINE FLOOD
    // Cram 50 GET requests into a single TCP stream.
    // Tests whether pipelining causes request/response mis-alignment.
    // ══════════════════════════════════════════════════════════════
    console.log('─── CAMPAIGN 6: HTTP PIPELINE FLOOD ─────────────────────');
    console.log('Cramming 50 pipelined requests into one TCP connection...');
    const pipeReq = Array.from({ length: 50 })
        .map(() => 'GET /health HTTP/1.1\r\nHost: localhost\r\n\r\n')
        .join('');
    const pipeRes = await tcpRaw(PORT, pipeReq + '\r\n', 8000);
    // Count HTTP 200 responses
    const pipeMatches = (pipeRes.match(/HTTP\/1\.\d 200/g) || []).length;
    if (pipeMatches >= 1) {
        report(6, 'HTTP Pipeline Flood', '🟢 DEFENDED', `Server handled pipeline gracefully — ${pipeMatches} valid responses`);
    } else {
        report(6, 'HTTP Pipeline Flood', '🔴 BREACHED', 'Pipeline flood caused response desync or crash');
    }

    // ══════════════════════════════════════════════════════════════
    // CAMPAIGN 7: BODY DESYNC — UNDERSIZE CONTENT-LENGTH
    // Lie about Content-Length (claim fewer bytes than sent).
    // Tests parser robustness when body is truncated by CL.
    // ══════════════════════════════════════════════════════════════
    console.log('─── CAMPAIGN 7: BODY DESYNC (Undersized Content-Length) ─');
    console.log('Sending 100 bytes of body but claiming Content-Length: 10...');
    const realBody = JSON.stringify({ password: 'correct', extra: 'X'.repeat(90) });
    const shortCL  = 10;
    const desyncReq =
        'POST /api/login HTTP/1.1\r\n' +
        'Host: localhost\r\n' +
        'Content-Type: application/json\r\n' +
        `Content-Length: ${shortCL}\r\n` +
        'Connection: close\r\n' +
        '\r\n' +
        realBody;
    const desyncRes = await tcpRaw(PORT, desyncReq);
    const desyncStatus = statusOf(desyncRes);
    // Parser should read only 10 bytes → invalid JSON → 400 or 401
    const desyncBreached = desyncRes.includes('"token"');
    if (!desyncBreached && desyncStatus !== 200) {
        report(7, 'Body Desync (short CL)', '🟢 DEFENDED', `Parser read only declared ${shortCL} bytes → status ${desyncStatus}`);
    } else {
        report(7, 'Body Desync (short CL)', '🔴 BREACHED', `Server parsed beyond Content-Length — got token!`);
    }

    // ══════════════════════════════════════════════════════════════
    // CAMPAIGN 8: MEMORY BOMB — CONCURRENT LARGE BODIES
    // Fire 30 simultaneous requests each with a 2 MB JSON body.
    // Tests memory guard and whether server survives heap pressure.
    // ══════════════════════════════════════════════════════════════
    console.log('─── CAMPAIGN 8: MEMORY BOMB (30 × 2 MB bodies) ──────────');
    console.log('Launching 30 concurrent 2 MB body requests...');
    const BOMB_SIZE = 2 * 1024 * 1024; // 2 MB
    const bomb = JSON.stringify({ data: 'A'.repeat(BOMB_SIZE - 20) });
    const bombRequests = Array.from({ length: 30 }).map(() =>
        tcpRaw(PORT,
            'POST /api/echo HTTP/1.1\r\n' +
            'Host: localhost\r\n' +
            'Content-Type: application/json\r\n' +
            `Content-Length: ${Buffer.byteLength(bomb)}\r\n` +
            'Connection: close\r\n' +
            '\r\n' + bomb,
            10000
        )
    );
    const [bombResults] = await Promise.all([
        Promise.allSettled(bombRequests),
        // In parallel, verify server is alive
        tcpRaw(PORT, 'GET /health HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n', 5000)
    ]);
    const healthAfterBomb = await tcpRaw(PORT, 'GET /health HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n', 5000);
    const bombRejected = (bombResults as PromiseSettledResult<string>[])
        .filter(r => r.status === 'fulfilled' && (r.value.includes('413') || r.value.includes('400') || r.value.includes('ERR'))).length;
    const serverAlive = statusOf(healthAfterBomb) === 200;
    if (serverAlive) {
        report(8, 'Memory Bomb (30×2MB)', '🟢 DEFENDED', `Server alive after 30×2MB bomb — ${bombRejected} requests rejected`);
    } else {
        report(8, 'Memory Bomb (30×2MB)', '🔴 BREACHED', 'Server became unresponsive after memory bomb!');
    }

    // ══════════════════════════════════════════════════════════════
    // CAMPAIGN 9: HEADER BOMB
    // Send a request with 500 unique headers to exhaust parser memory
    // or cause catastrophic O(n²) header parsing.
    // ══════════════════════════════════════════════════════════════
    console.log('─── CAMPAIGN 9: HEADER BOMB (500 unique headers) ────────');
    console.log('Sending 500 unique request headers in a single request...');
    const extraHeaders = Array.from({ length: 500 })
        .map((_, i) => `X-Bomb-${i}: ${'V'.repeat(50)}`)
        .join('\r\n');
    const headerBombReq =
        'GET /health HTTP/1.1\r\n' +
        'Host: localhost\r\n' +
        extraHeaders + '\r\n' +
        'Connection: close\r\n' +
        '\r\n';
    const headerBombRes = await tcpRaw(PORT, headerBombReq, 8000);
    const headerBombStatus = statusOf(headerBombRes);
    const hbAlive = await tcpRaw(PORT, 'GET /health HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n', 3000);
    if (headerBombStatus !== 0 && statusOf(hbAlive) === 200) {
        report(9, 'Header Bomb (500 headers)', '🟢 DEFENDED', `Server returned ${headerBombStatus} and remained alive`);
    } else {
        report(9, 'Header Bomb (500 headers)', '🔴 BREACHED', 'Server crashed or became unresponsive from header flood');
    }

    // ══════════════════════════════════════════════════════════════
    // CAMPAIGN 10: UNICODE PATH TRAVERSAL
    // Use percent-encoded dot-dot sequences to bypass path guards.
    // Classic: /%2e%2e/%2e%2e/etc/passwd
    // ══════════════════════════════════════════════════════════════
    console.log('─── CAMPAIGN 10: UNICODE PATH TRAVERSAL ─────────────────');
    console.log('Trying %2e%2e/%2e%2e/etc/passwd and similar traversal patterns...');
    const traversalPaths = [
        '/%2e%2e/%2e%2e/etc/passwd',
        '/..%2F..%2Fetc%2Fpasswd',
        '/%2e%2e%5c%2e%2e%5cwindows%5cwin.ini',
        '/api/data%2F..%2F..%2Fadmin',
        '/api/..%2F..%2Fdata',
    ];
    let traversalLeaked = 0;
    for (const p of traversalPaths) {
        const r = await tcpRaw(PORT, `GET ${p} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`);
        if (statusOf(r) === 200 && (r.includes('root:') || r.includes('TOP_SECRET') || r.includes('ADMIN_TOKEN'))) {
            traversalLeaked++;
        }
    }
    if (traversalLeaked === 0) {
        report(10, 'Unicode Path Traversal', '🟢 DEFENDED', `All ${traversalPaths.length} traversal paths returned non-200 or no sensitive data`);
    } else {
        report(10, 'Unicode Path Traversal', '🔴 BREACHED', `${traversalLeaked} traversal paths exposed sensitive data!`);
    }

    // ══════════════════════════════════════════════════════════════
    // CAMPAIGN 11: HTTP METHOD OVERRIDE
    // Send POST with X-HTTP-Method-Override: DELETE to test if
    // the server blindly overrides the method and executes DELETE.
    // ══════════════════════════════════════════════════════════════
    console.log('─── CAMPAIGN 11: HTTP METHOD OVERRIDE ───────────────────');
    console.log('Sending POST + X-HTTP-Method-Override: DELETE to override method...');
    const methodOverride =
        'POST /api/admin HTTP/1.1\r\n' +
        'Host: localhost\r\n' +
        'X-HTTP-Method-Override: DELETE\r\n' +
        'X-Method-Override: DELETE\r\n' +
        '_method: DELETE\r\n' +
        'Connection: close\r\n' +
        '\r\n';
    const methodOverrideRes = await tcpRaw(PORT, methodOverride);
    // /api/admin only has GET registered — POST should 404
    const methodStatus = statusOf(methodOverrideRes);
    if (methodStatus === 404) {
        report(11, 'HTTP Method Override', '🟢 DEFENDED', `POST to GET-only route returned 404 — override header ignored`);
    } else if (methodStatus === 200) {
        report(11, 'HTTP Method Override', '🔴 BREACHED', 'Method override succeeded — route was accessed via wrong method!');
    } else {
        report(11, 'HTTP Method Override', '🟡 PARTIAL', `Returned ${methodStatus} — override rejected but not 404`);
    }

    // ══════════════════════════════════════════════════════════════
    // CAMPAIGN 12: CACHE DECEPTION ATTACK
    // Access /api/data/styles.css — attacker tricks a CDN into
    // caching the sensitive JSON response as a public static asset.
    // ══════════════════════════════════════════════════════════════
    console.log('─── CAMPAIGN 12: CACHE DECEPTION ATTACK ─────────────────');
    console.log('Requesting /api/data/styles.css to trick CDN caching...');
    const cacheDecepRes = await tcpRaw(PORT, 'GET /api/data/styles.css HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n');
    const cacheStatus = statusOf(cacheDecepRes);
    const cacheLeaked = cacheDecepRes.includes('TOP_SECRET_DATA');
    const hasCacheControl = cacheDecepRes.toLowerCase().includes('cache-control') ||
                            cacheDecepRes.toLowerCase().includes('no-store');
    if (!cacheLeaked && cacheStatus !== 200) {
        report(12, 'Cache Deception Attack', '🟢 DEFENDED', `Non-existent path returned ${cacheStatus} — data not leaked to fake asset path`);
    } else if (cacheLeaked && !hasCacheControl) {
        report(12, 'Cache Deception Attack', '🔴 BREACHED', 'Secret data returned via CSS path with no cache-control headers!');
    } else {
        report(12, 'Cache Deception Attack', '🟡 PARTIAL', `Status ${cacheStatus} — review cache headers: ${hasCacheControl ? 'present' : 'MISSING'}`);
    }

    // ══════════════════════════════════════════════════════════════
    // CAMPAIGN 13: REDOS VIA ROUTE PARAMETER
    // Send a catastrophically backtracking string as a route param.
    // Target: GET /api/user/:id — id is reflected back.
    // ══════════════════════════════════════════════════════════════
    console.log('─── CAMPAIGN 13: REDOS VIA ROUTE PARAMETER ──────────────');
    console.log('Sending catastrophic backtracking string as :id route param...');
    // A string that causes catastrophic backtracking in (a+)+ style regexes
    const redosStr = 'a'.repeat(30) + '!'; // "aaaa...!" — triggers backtracking
    const redosStart = Date.now();
    const redosRes = await tcpRaw(PORT,
        `GET /api/user/${redosStr} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`,
        3000
    );
    const redosMs = Date.now() - redosStart;
    const redosStatus = statusOf(redosRes);
    if (redosMs < 2000 && redosStatus !== 0) {
        report(13, 'ReDoS via Route Param', '🟢 DEFENDED', `Router resolved in ${redosMs}ms — no catastrophic backtracking`);
    } else if (redosMs >= 2000) {
        report(13, 'ReDoS via Route Param', '🔴 BREACHED', `Router hung for ${redosMs}ms — ReDoS vulnerability confirmed!`);
    } else {
        report(13, 'ReDoS via Route Param', '🟡 PARTIAL', `Status ${redosStatus} in ${redosMs}ms`);
    }

    // ══════════════════════════════════════════════════════════════
    // CAMPAIGN 14: PROTOTYPE POLLUTION VIA JSON BODY
    // Send __proto__, constructor, and prototype keys in JSON body.
    // If body is naively merged, this can pollute Object.prototype.
    // ══════════════════════════════════════════════════════════════
    console.log('─── CAMPAIGN 14: PROTOTYPE POLLUTION (JSON body) ────────');
    console.log('Sending __proto__ and constructor keys in JSON body...');
    const pollutionPayloads = [
        '{"__proto__":{"isAdmin":true,"polluted":"yes"}}',
        '{"constructor":{"prototype":{"isAdmin":true}}}',
        '{"__proto__.isAdmin":true}',
        '{"a":{"__proto__":{"isAdmin":true}}}',
    ];
    let pollutionSuccess = 0;
    for (const payload of pollutionPayloads) {
        await tcpRaw(PORT,
            'POST /api/echo HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\n' +
            `Content-Length: ${Buffer.byteLength(payload)}\r\nConnection: close\r\n\r\n` + payload
        );
    }
    // Check if pollution worked by checking a new empty object
    const polluted = (({} as any).isAdmin === true);
    if (!polluted) {
        report(14, 'Prototype Pollution (JSON)', '🟢 DEFENDED', `Object.prototype.isAdmin = ${({} as any).isAdmin} — no pollution`);
    } else {
        report(14, 'Prototype Pollution (JSON)', '🔴 BREACHED', `Object.prototype polluted! isAdmin=${({} as any).isAdmin}`);
        pollutionSuccess++;
    }

    // ══════════════════════════════════════════════════════════════
    // CAMPAIGN 15: CONTENT-TYPE CONFUSION (XML in JSON endpoint)
    // Send XML with an entity bomb inside a JSON-typed request.
    // Tests if the server blindly parses declared Content-Type.
    // ══════════════════════════════════════════════════════════════
    console.log('─── CAMPAIGN 15: CONTENT-TYPE CONFUSION (XML entity bomb) ');
    console.log('Sending XML entity bomb with Content-Type: application/json...');
    const xmlBomb =
        '<?xml version="1.0"?>' +
        '<!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;">]>' +
        '<lolz>&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;</lolz>';
    const xmlConfusionStart = Date.now();
    const xmlRes = await tcpRaw(PORT,
        'POST /api/echo HTTP/1.1\r\nHost: localhost\r\n' +
        'Content-Type: application/json\r\n' +
        `Content-Length: ${Buffer.byteLength(xmlBomb)}\r\n` +
        'Connection: close\r\n\r\n' + xmlBomb,
        5000
    );
    const xmlMs = Date.now() - xmlConfusionStart;
    const xmlStatus = statusOf(xmlRes);
    // Server should reject (400) or error, not hang for seconds parsing XML entities
    if (xmlMs < 3000 && xmlStatus !== 0) {
        report(15, 'Content-Type Confusion (XML bomb)', '🟢 DEFENDED', `Returned ${xmlStatus} in ${xmlMs}ms — XML bomb not processed`);
    } else {
        report(15, 'Content-Type Confusion (XML bomb)', '🔴 BREACHED', `Server processed XML for ${xmlMs}ms — bomb worked or hung`);
    }

    // ══════════════════════════════════════════════════════════════
    // CAMPAIGN 16: MALFORMED CHUNKED TRANSFER ENCODING
    // Send a chunked body with invalid chunk size (hex overflow,
    // negative size, NaN) to crash the parser.
    // ══════════════════════════════════════════════════════════════
    console.log('─── CAMPAIGN 16: MALFORMED CHUNKED ENCODING ─────────────');
    console.log('Sending malformed chunk sizes to crash the HTTP parser...');
    const chunkedPayloads = [
        // Invalid hex chunk size (letter G is not valid hex)
        'POST /api/echo HTTP/1.1\r\nHost: localhost\r\nTransfer-Encoding: chunked\r\nContent-Type: application/json\r\nConnection: close\r\n\r\nGGGG\r\n{"x":1}\r\n0\r\n\r\n',
        // Negative chunk size
        'POST /api/echo HTTP/1.1\r\nHost: localhost\r\nTransfer-Encoding: chunked\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n-1\r\n{"x":1}\r\n0\r\n\r\n',
        // Astronomically large chunk size (claimed 1 TB)
        'POST /api/echo HTTP/1.1\r\nHost: localhost\r\nTransfer-Encoding: chunked\r\nContent-Type: application/json\r\nConnection: close\r\n\r\nFFFFFFFFFF\r\n{"x":1}',
    ];
    let chunkedCrash = 0;
    for (const p of chunkedPayloads) {
        const r = await tcpRaw(PORT, p, 4000);
        if (r === '(timeout)' || r === '' || r.startsWith('ERR:')) chunkedCrash++;
    }
    const chunkedAlive = statusOf(
        await tcpRaw(PORT, 'GET /health HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n', 3000)
    ) === 200;
    if (chunkedAlive && chunkedCrash < chunkedPayloads.length) {
        report(16, 'Malformed Chunked Encoding', '🟢 DEFENDED', `Server alive — ${chunkedCrash}/${chunkedPayloads.length} requests caused socket close (expected)`);
    } else if (!chunkedAlive) {
        report(16, 'Malformed Chunked Encoding', '🔴 BREACHED', 'Server crashed after malformed chunked request!');
    } else {
        report(16, 'Malformed Chunked Encoding', '🟡 PARTIAL', `Server alive — ${chunkedCrash}/${chunkedPayloads.length} dropped`);
    }

    // ══════════════════════════════════════════════════════════════
    // CAMPAIGN 17: HTTP/0.9 DOWNGRADE ATTACK
    // Send a bare HTTP/0.9 request (no version line, no headers).
    // Some parsers accept this and can be exploited via request desync.
    // ══════════════════════════════════════════════════════════════
    console.log('─── CAMPAIGN 17: HTTP/0.9 DOWNGRADE ─────────────────────');
    console.log('Sending bare HTTP/0.9 request (no version, no headers)...');
    const http09Res = await tcpRaw(PORT, 'GET /api/data\r\n', 3000);
    const http09Status = statusOf(http09Res);
    // Node's http module rejects bare HTTP/0.9 requests natively
    const http09Alive = statusOf(
        await tcpRaw(PORT, 'GET /health HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n', 3000)
    ) === 200;
    if (http09Alive && !http09Res.includes('TOP_SECRET_DATA')) {
        report(17, 'HTTP/0.9 Downgrade', '🟢 DEFENDED', `Server alive and data not leaked via HTTP/0.9 (response: ${http09Status || 'empty/rejected'})`);
    } else if (!http09Alive) {
        report(17, 'HTTP/0.9 Downgrade', '🔴 BREACHED', 'Server crashed on HTTP/0.9 request!');
    } else {
        report(17, 'HTTP/0.9 Downgrade', '🔴 BREACHED', 'Data leaked via HTTP/0.9 request!');
    }

    // ══════════════════════════════════════════════════════════════
    // CAMPAIGN 18: ERROR CASCADE STORM
    // Fire 50 simultaneous requests to /api/crash (throws internally).
    // Tests whether cascading errors crash the event loop or corrupt
    // response state across concurrent requests.
    // ══════════════════════════════════════════════════════════════
    console.log('─── CAMPAIGN 18: ERROR CASCADE STORM (50 concurrent) ────');
    console.log('Firing 50 simultaneous intentional crashes at the server...');
    const crashRequests = Array.from({ length: 50 }).map(() =>
        tcpRaw(PORT,
            'POST /api/crash HTTP/1.1\r\nHost: localhost\r\nContent-Length: 0\r\nConnection: close\r\n\r\n',
            5000
        )
    );
    const crashResults = await Promise.allSettled(crashRequests);
    const crash500s = (crashResults as PromiseSettledResult<string>[])
        .filter(r => r.status === 'fulfilled' && r.value.includes('500')).length;
    // After the storm, server must still handle valid requests
    await new Promise(r => setTimeout(r, 300));
    const crashHealth = statusOf(
        await tcpRaw(PORT, 'GET /health HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n', 5000)
    );
    if (crashHealth === 200) {
        report(18, 'Error Cascade Storm', '🟢 DEFENDED', `Server alive after 50 concurrent crashes — ${crash500s}/50 returned proper 500s`);
    } else {
        report(18, 'Error Cascade Storm', '🔴 BREACHED', `Server unresponsive after error storm! Health: ${crashHealth}`);
    }

    // ══════════════════════════════════════════════════════════════
    // CAMPAIGN 19: CONNECTION FLOOD (Zombie Sockets)
    // Open 200 TCP connections, never send any data.
    // Tests whether idle sockets exhaust the server's connection pool.
    // ══════════════════════════════════════════════════════════════
    console.log('─── CAMPAIGN 19: CONNECTION FLOOD (200 zombie sockets) ───');
    console.log('Opening 200 TCP connections and sending nothing...');
    const zombies: net.Socket[] = [];
    let zombieConnectErrors = 0;
    for (let i = 0; i < 200; i++) {
        const s = net.createConnection({ port: PORT, host: '127.0.0.1' });
        s.on('error', () => { zombieConnectErrors++; });
        // Deliberately do NOT write anything — zombie connection
        zombies.push(s);
    }
    await new Promise(r => setTimeout(r, 500));
    const zombieHealth = await tcpRaw(PORT, 'GET /health HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n', 4000);
    zombies.forEach(s => s.destroy());
    if (statusOf(zombieHealth) === 200) {
        report(19, 'Connection Flood (200 zombies)', '🟢 DEFENDED', `Server responded to health check despite ${200 - zombieConnectErrors} zombie connections`);
    } else {
        report(19, 'Connection Flood (200 zombies)', '🔴 BREACHED', `Server unresponsive under zombie connection flood!`);
    }

    // ══════════════════════════════════════════════════════════════
    // CAMPAIGN 20: RESPONSE SPLITTING via Location Header
    // Inject CRLF into the ?to= redirect param to inject a fake
    // HTTP response body and split the stream for the next request.
    // ══════════════════════════════════════════════════════════════
    console.log('─── CAMPAIGN 20: RESPONSE SPLITTING (Location header) ───');
    console.log('Injecting \\r\\n\\r\\n into Location to forge a second response...');
    // Craft: /redirect?to=http://safe.com\r\nContent-Length: 0\r\n\r\nHTTP/1.1 200 OK\r\n...
    const splitPayload = '/redirect?to=' +
        encodeURIComponent('http://safe.com\r\nContent-Length: 0\r\n\r\nHTTP/1.1 200 OK\r\nX-Forged: true\r\n\r\n');
    const splitReq = `GET ${splitPayload} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`;
    const splitRes = await tcpRaw(PORT, splitReq);
    const splitForged = splitRes.includes('X-Forged: true') ||
                        (splitRes.match(/HTTP\/1\.\d 200/g) || []).length > 1;
    if (!splitForged) {
        report(20, 'Response Splitting (CRLF→Location)', '🟢 DEFENDED', 'CRLF neutralized in Location — response not split');
    } else {
        report(20, 'Response Splitting (CRLF→Location)', '🔴 BREACHED', 'Response splitting succeeded! Forged HTTP response visible');
    }
}

// ─── FINAL SCORE BOARD ──────────────────────────────────────────────────────
function printScoreboard() {
    console.log('\n' + '═'.repeat(60));
    console.log('🏆  RED TEAM SIMULATION — FINAL REPORT');
    console.log('═'.repeat(60));
    const defended  = results.filter(r => r.verdict === '🟢 DEFENDED').length;
    const breached  = results.filter(r => r.verdict === '🔴 BREACHED').length;
    const partial   = results.filter(r => r.verdict === '🟡 PARTIAL').length;
    console.log(`\n  🟢 DEFENDED : ${defended}/${results.length}`);
    console.log(`  🔴 BREACHED : ${breached}/${results.length}`);
    console.log(`  🟡 PARTIAL  : ${partial}/${results.length}`);
    console.log('\n  Per-Campaign Breakdown:');
    results.forEach(r =>
        console.log(`    [${String(r.id).padStart(2, '0')}] ${r.verdict}  ${r.name}`)
    );
    console.log('\n' + '═'.repeat(60));
    if (breached === 0) {
        console.log('  ✅ Server withstood all 20 attack campaigns!');
    } else {
        console.log(`  ⚠️  ${breached} campaign(s) breached — review findings above.`);
    }
    console.log('═'.repeat(60) + '\n');
    if (typeof app !== 'undefined') app.close();;
}

// ─── Boot ───────────────────────────────────────────────────────────────────
app.start(async () => {
    try {
        await runAttacks();
    } catch (e) {
        console.error('Unexpected simulation error:', e);
    } finally {
        printScoreboard();
    }
});
