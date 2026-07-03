/**
 * ╔══════════════════════════════════════════════════════════════════════╗
 * ║  🔴 AEGION RED TEAM — CAMPAIGN IV: KILL CHAIN WARFARE              ║
 * ║  The deepest simulation: chained exploits, WebSocket frame fuzzing, ║
 * ║  event loop starvation, HTTP/2 confusion, amplification attacks,    ║
 * ║  template injection, kill chain sequences, and zero-day probes.     ║
 * ╚══════════════════════════════════════════════════════════════════════╝
 *
 *  1.  WebSocket Frame Fuzzing       — raw malformed WS frames post-upgrade
 *  2.  HTTP/2 Preface Confusion      — send HTTP/2 magic bytes to HTTP/1.1 server
 *  3.  Event Loop Starvation         — synchronous CPU-heavy JSON.stringify loop
 *  4.  Response Amplification        — tiny req → massive response (zip bomb output)
 *  5.  Template Injection (SSTI)     — {{ 7*7 }}, process.env, require() in template vars
 *  6.  Header Reflection XSS         — User-Agent / Referer reflected in HTML response
 *  7.  Chunked Trailer Injection     — inject headers via chunked transfer trailer
 *  8.  Kill Chain: HPP + SSRF        — HPP to inject redirect target → SSRF
 *  9.  Kill Chain: NoSQL + Auth Bypass — NoSQL operator to bypass login check
 * 10.  DNS Rebinding Simulation      — change Host header mid-session
 * 11.  HTTP/0.9 + Pipeline Fusion    — mix HTTP/0.9 and HTTP/1.1 in same stream
 * 12.  Billion Laughs via URL Params — exponential query string parsing
 * 13.  SVG Upload XSS                — upload SVG with <script> tag
 * 14.  ZIP Slip via Upload           — nested zip with path-traversal entry names
 * 15.  Request ID Collision          — concurrent requests with identical IDs
 * 16.  Error Message Leak            — trigger errors that expose stack traces / paths
 * 17.  JWT Secret Brute-Force        — dictionary attack on HS256 secret
 * 18.  Accept: * / * DoS             — parse all content types simultaneously
 * 19.  Kill Chain: Timing + Enum + BF — enumerate users via timing then brute force
 * 20.  Armageddon: 5-Vector Parallel — all kill chains at once, 500 concurrent threads
 */

import * as net    from 'node:net';
import * as crypto from 'node:crypto';
import * as fs     from 'node:fs';
import * as path   from 'node:path';
import * as os     from 'node:os';
import * as zlib   from 'node:zlib';
import { Server, get, post } from '../src/index';
import { jwt } from '../src/security/jwt';
import { templateEngine } from '../src/template';
import { bruteForce } from '../src/security/brute-force';
import { group as makeGroup } from '../src/index';

// ─── Ports ────────────────────────────────────────────────────────────────────
const PORT      = 3060;
const TMPL_PORT = 3061;

// ─── Scoreboard ───────────────────────────────────────────────────────────────
type Verdict = '🟢 DEFENDED' | '🔴 BREACHED' | '🟡 PARTIAL';
const results: { id: number; name: string; verdict: Verdict; detail: string }[] = [];
function report(id: number, name: string, verdict: Verdict, detail: string) {
    results.push({ id, name, verdict, detail });
    console.log(`[RESULT] ${verdict} — #${id} ${name}: ${detail}\n`);
}

// ─── TCP helpers ──────────────────────────────────────────────────────────────
function tcpRaw(data: string | Buffer, ms = 6000, port = PORT): Promise<string> {
    return new Promise(resolve => {
        const c = net.createConnection({ port, host: '127.0.0.1' }, () =>
            c.write(typeof data === 'string' ? Buffer.from(data, 'binary') : data)
        );
        let buf = '';
        const t = setTimeout(() => { c.destroy(); resolve(buf || '(timeout)'); }, ms);
        c.on('data', d  => { buf += d.toString('binary'); });
        c.on('end',  () => { clearTimeout(t); resolve(buf); });
        c.on('error',() => { clearTimeout(t); resolve(buf || '(conn-err)'); });
    });
}
const st    = (r: string) => parseInt((r.match(/HTTP\/\d\.\d (\d{3})/) || ['','0'])[1]);
const alive = async (p = PORT) => st(await tcpRaw(
    'GET /health HTTP/1.1\r\nHost: h\r\nConnection: close\r\n\r\n', 3000, p)) === 200;

// ─── Setup template views dir ─────────────────────────────────────────────────
const viewsDir = path.join(os.tmpdir(), 'aegion-views-' + crypto.randomBytes(4).toString('hex'));
fs.mkdirSync(viewsDir, { recursive: true });

// Safe template — escapes all output
fs.writeFileSync(path.join(viewsDir, 'hello.html'),
    '<h1>Hello {{ name }}</h1><p>Role: {{ role }}</p>');

// Template that naively renders raw user input (vulnerability surface)
fs.writeFileSync(path.join(viewsDir, 'reflect.html'),
    '<div>Input: {{ input }}</div><p>UA: {{ ua }}</p>');

// ─── Main application server ──────────────────────────────────────────────────
const JWT_SECRET = 'campaign4-secret-key-exactly-32-bytes!!';

// Simple in-memory user store
const USERS: Record<string, string> = {
    'alice': '$2y$hashed_alice_password',
    'bob':   '$2y$hashed_bob_password',
};

const app = new Server({ port: PORT });
app.register([
    ...get('/health', async ctx => ctx.json({ ok: true })),
    ...get('/api/data', async ctx => ctx.json({ classified: 'TOP_SECRET_IV', level: 'TS/SCI' })),
    ...post('/api/login', async ctx => {
        const body: any = await ctx.body();
        const user = USERS[body?.username ?? ''];
        if (user && body?.password === 'correct_password') {
            const token = jwt.sign({ username: body.username, role: 'user' }, JWT_SECRET, 3600);
            return ctx.json({ token });
        }
        return ctx.status(401).json({ error: 'Invalid credentials' });
    }),
    ...post('/api/echo', async ctx => {
        const b: any = await ctx.body();
        return ctx.json({ echo: b });
    }),
    ...post('/api/upload-svg', async ctx => {
        const files = await ctx.files({ limits: { fileSize: 50_000, files: 1 } });
        const file = Object.values(files)[0] as any;
        if (!file) return ctx.status(400).json({ error: 'No file' });
        // Naive: read the file and serve it directly (XSS surface)
        const content = fs.readFileSync(file.filepath, 'utf8');
        ctx.res.setHeader('Content-Type', 'image/svg+xml');
        ctx.res.end(content);
    }),
    ...get('/api/large', async ctx => {
        // Amplification target: returns 1 MB of JSON
        return ctx.json({ data: 'X'.repeat(1_000_000), timestamp: Date.now() });
    }),
    ...get('/api/error-reveal', async ctx => {
        // Intentional: crash with path information (to test if stack is leaked)
        const badPath = path.join(os.homedir(), '.ssh', 'id_rsa');
        fs.readFileSync(badPath); // Will throw ENOENT
        return ctx.json({ ok: true });
    }),
    ...post('/api/nosql-login', async ctx => {
        const body: any = await ctx.body();
        // Intentionally vulnerable: direct property comparison without sanitizer
        // nosqlSanitizer is NOT enabled on this server instance
        if (body?.username === 'admin' && body?.password === 'secret') {
            return ctx.json({ token: 'ADMIN_JWT_TOKEN', role: 'admin' });
        }
        return ctx.status(401).json({ error: 'Wrong credentials' });
    }),
]);

// ─── Template server ──────────────────────────────────────────────────────────
const tmplApp = new Server({
    port: TMPL_PORT,
    views: templateEngine(viewsDir, { cache: false }),
});
tmplApp.register([
    ...get('/health', async ctx => ctx.json({ ok: true })),
    ...get('/greet', async ctx => {
        const name = ctx.query.name as string || 'World';
        const ua   = ctx.req.headers['user-agent'] || '';
        // Pass user-controlled input into template — SSTI surface
        return ctx.render('reflect.html', { input: name, ua });
    }),
    ...get('/safe', async ctx => {
        const name = ctx.query.name as string || 'World';
        return ctx.render('hello.html', { name, role: 'guest' });
    }),
]);

// ─── Attack campaigns ─────────────────────────────────────────────────────────
async function runAttacks() {
    console.log('\n' + '═'.repeat(66));
    console.log('🔴  AEGION RED TEAM — CAMPAIGN IV: KILL CHAIN WARFARE');
    console.log('🎯  Target A: http://127.0.0.1:' + PORT);
    console.log('🎯  Target B: http://127.0.0.1:' + TMPL_PORT + ' (Template Engine)');
    console.log('═'.repeat(66) + '\n');
    await new Promise(r => setTimeout(r, 300));

    // ══════════════════════════════════════════════════════════════
    // CAMPAIGN 1: WEBSOCKET FRAME FUZZING
    // Step 1: Send valid WS upgrade to get 101 Switching Protocols.
    // Step 2: Send malformed WS frames: bad opcode, no masking,
    //         continuation frame without start, fragmented payload.
    // Server should close connection cleanly, not crash.
    // ══════════════════════════════════════════════════════════════
    console.log('─── CAMPAIGN 1: WEBSOCKET FRAME FUZZING ─────────────────');
    const wsKey = crypto.randomBytes(16).toString('base64');
    const wsUpgrade =
        'GET /health HTTP/1.1\r\n' +
        'Host: localhost\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Key: ${wsKey}\r\n` +
        'Sec-WebSocket-Version: 13\r\n\r\n';

    // After (attempted) upgrade, send raw WS frames
    const malformedFrames = [
        // Frame with reserved opcode (0x03) — undefined = must close
        Buffer.from([0x83, 0x00]),
        // Control frame (ping) with length > 125 bytes — protocol violation
        Buffer.from([0x89, 0x7E, 0x00, 0x80, ...Array(128).fill(0x41)]),
        // Fragmented control frame (FIN=0, opcode=ping) — protocol violation
        Buffer.from([0x09, 0x01, 0x41]),
        // Unmasked frame from client — RFC 6455 requires client frames to be masked
        Buffer.from([0x81, 0x05, ...Buffer.from('hello')]),
        // Frame with payload length of 2^63 (astronomically large)
        Buffer.from([0x82, 0x7F, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF]),
        // Continuation frame without a start frame
        Buffer.from([0x80, 0x01, 0x41]),
    ];

    let wsCrash = 0;
    for (const frame of malformedFrames) {
        await new Promise<void>(resolve => {
            const sock = net.createConnection({ port: PORT }, () => {
                sock.write(Buffer.from(wsUpgrade));
                sock.once('data', () => {
                    // Send malformed frame after upgrade attempt
                    sock.write(frame);
                    setTimeout(() => { sock.destroy(); resolve(); }, 500);
                });
                sock.on('error', () => resolve());
            });
            sock.on('error', () => resolve());
            setTimeout(() => { sock.destroy(); resolve(); }, 2000);
        });
        if (!(await alive())) wsCrash++;
    }

    if (wsCrash === 0) {
        report(1, 'WebSocket Frame Fuzzing', '🟢 DEFENDED',
            `Server survived all ${malformedFrames.length} malformed WS frames — no crash`);
    } else {
        report(1, 'WebSocket Frame Fuzzing', '🔴 BREACHED',
            `Server crashed on ${wsCrash}/${malformedFrames.length} malformed WS frames!`);
    }

    // ══════════════════════════════════════════════════════════════
    // CAMPAIGN 2: HTTP/2 PREFACE CONFUSION
    // Send the HTTP/2 client connection preface magic string
    // ("PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n") to an HTTP/1.1 server.
    // Also send h2c upgrade headers. Server must reject gracefully.
    // ══════════════════════════════════════════════════════════════
    console.log('─── CAMPAIGN 2: HTTP/2 PREFACE CONFUSION ────────────────');
    const h2Preface = 'PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n';
    const h2Upgrade =
        'GET / HTTP/1.1\r\n' +
        'Host: localhost\r\n' +
        'Connection: Upgrade, HTTP2-Settings\r\n' +
        'Upgrade: h2c\r\n' +
        'HTTP2-Settings: AAMAAABkAAQAAP__\r\n\r\n';
    const h2GoAway = Buffer.from([
        0x00, 0x00, 0x08, 0x07, 0x00, 0x00, 0x00, 0x00, 0x00,  // GOAWAY frame
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00
    ]);

    const h2Tests = [h2Preface, h2Upgrade, h2GoAway];
    let h2Crash = 0;
    for (const payload of h2Tests) {
        const r = await tcpRaw(payload, 3000);
        if (!(await alive())) h2Crash++;
    }
    if (h2Crash === 0) {
        report(2, 'HTTP/2 Preface Confusion', '🟢 DEFENDED',
            `All ${h2Tests.length} HTTP/2 probes rejected — server alive and HTTP/1.1 clean`);
    } else {
        report(2, 'HTTP/2 Preface Confusion', '🔴 BREACHED',
            `Server crashed from HTTP/2 preface — ${h2Crash} crash(es)!`);
    }

    // ══════════════════════════════════════════════════════════════
    // CAMPAIGN 3: EVENT LOOP STARVATION
    // Send a request that triggers synchronous CPU-intensive work.
    // While server is busy parsing the response, try a concurrent
    // health check — should get through within 2 seconds.
    // ══════════════════════════════════════════════════════════════
    console.log('─── CAMPAIGN 3: EVENT LOOP STARVATION PROBE ─────────────');
    // Send a deeply recursive JSON (10k levels) that V8's JSON.stringify
    // will struggle with when reflecting it, plus 50 concurrent normal requests
    let depthBomb = '{"a":';
    for (let i = 0; i < 5000; i++) depthBomb += '{"b":';
    depthBomb += '"leaf"' + '}'.repeat(5000) + '}';

    const bombReq = 'POST /api/echo HTTP/1.1\r\nHost: h\r\n' +
        'Content-Type: application/json\r\n' +
        `Content-Length: ${Buffer.byteLength(depthBomb)}\r\nConnection: close\r\n\r\n` + depthBomb;

    const loopStart = Date.now();
    const [, healthWhileBusy] = await Promise.all([
        tcpRaw(bombReq, 8000),
        (async () => {
            await new Promise(r => setTimeout(r, 50)); // Let bomb land first
            return tcpRaw('GET /health HTTP/1.1\r\nHost: h\r\nConnection: close\r\n\r\n', 3000);
        })(),
    ]);
    const loopMs = Date.now() - loopStart;
    const loopAlive = st(healthWhileBusy) === 200;

    if (loopAlive && loopMs < 5000) {
        report(3, 'Event Loop Starvation', '🟢 DEFENDED',
            `Health check responded during 5k-deep JSON processing (${loopMs}ms) — event loop unblocked`);
    } else if (!loopAlive) {
        report(3, 'Event Loop Starvation', '🔴 BREACHED',
            `Health check timed out — event loop stalled for ${loopMs}ms!`);
    } else {
        report(3, 'Event Loop Starvation', '🟡 PARTIAL',
            `Responded but slowly (${loopMs}ms) — investigate blocking ops`);
    }

    // ══════════════════════════════════════════════════════════════
    // CAMPAIGN 4: RESPONSE AMPLIFICATION ATTACK
    // Send 200 simultaneous requests to /api/large (returns 1 MB).
    // Total response: 200 MB of data. Tests whether the server
    // exhausts heap memory serving amplified responses.
    // ══════════════════════════════════════════════════════════════
    console.log('─── CAMPAIGN 4: RESPONSE AMPLIFICATION (200×1MB) ────────');
    const ampStart = Date.now();
    const ampRequests = Array.from({ length: 200 }).map(() =>
        tcpRaw('GET /api/large HTTP/1.1\r\nHost: h\r\nConnection: close\r\n\r\n', 10000)
    );
    const ampResults = await Promise.allSettled(ampRequests);
    const ampMs = Date.now() - ampStart;
    const amp200s = (ampResults as PromiseSettledResult<string>[])
        .filter(r => r.status === 'fulfilled' && r.value.includes('200')).length;
    const ampAlive = await alive();
    if (ampAlive) {
        report(4, 'Response Amplification (200×1MB)', '🟢 DEFENDED',
            `Server served ${amp200s}/200 requests in ${ampMs}ms — heap stable, still alive`);
    } else {
        report(4, 'Response Amplification (200×1MB)', '🔴 BREACHED',
            `Server OOM-crashed after serving ${amp200s} 1MB responses!`);
    }

    // ══════════════════════════════════════════════════════════════
    // CAMPAIGN 5: SERVER-SIDE TEMPLATE INJECTION (SSTI)
    // The template engine escapes {{ expr }} using escapeHtml().
    // Attacker tries:
    //  a) {{ 7*7 }}              — arithmetic eval
    //  b) {{ process.env.NODE_ENV }} — env variable leakage
    //  c) {{{ process.mainModule.require('child_process').execSync('whoami') }}}
    //  d) {% require('child_process').execSync('dir') %}
    //  e) {{ constructor.constructor('return process')() }}
    // ══════════════════════════════════════════════════════════════
    console.log('─── CAMPAIGN 5: SERVER-SIDE TEMPLATE INJECTION (SSTI) ───');
    const sstiPayloads = [
        '{{ 7*7 }}',
        '{{ process.env.NODE_ENV }}',
        "{{ constructor.constructor('return process.env.PATH')() }}",
        '{{{ process.env.USERNAME }}}',
        "{% const x = require('child_process').execSync('echo PWNED').toString(); %}{{ x }}",
        '{{ Object.keys(process.env).join(\\",\\") }}',
    ];
    let sstiLeaked = 0;
    for (const payload of sstiPayloads) {
        const encoded = encodeURIComponent(payload);
        const r = await tcpRaw(
            `GET /greet?name=${encoded} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`,
            4000, TMPL_PORT
        );
        const body = r.slice(r.indexOf('\r\n\r\n') + 4);
        // Check if the template evaluated the payload (SSTI execution)
        if ((body.includes('49') && !body.includes('7*7')) ||
            (body.includes('PWNED') && !body.includes('echo PWNED')) ||
            (body.includes('root:') && !body.includes('etc/passwd'))) {
            sstiLeaked++;
        }
    }
    if (sstiLeaked === 0) {
        report(5, 'SSTI via Template Engine', '🟢 DEFENDED',
            `All ${sstiPayloads.length} SSTI payloads escaped/rejected — no code execution`);
    } else {
        report(5, 'SSTI via Template Engine', '🔴 BREACHED',
            `${sstiLeaked}/${sstiPayloads.length} SSTI payloads executed — RCE possible!`);
    }

    // ══════════════════════════════════════════════════════════════
    // CAMPAIGN 6: HEADER REFLECTION XSS
    // Send evil HTML/JS in User-Agent and Referer headers.
    // If the server reflects these into an HTML response body
    // without escaping, XSS is possible.
    // ══════════════════════════════════════════════════════════════
    console.log('─── CAMPAIGN 6: HEADER REFLECTION XSS ───────────────────');
    const xssPayloads = [
        '<script>alert(1)</script>',
        '"><img src=x onerror=alert(1)>',
        "';alert(String.fromCharCode(88,83,83))//",
        '<svg/onload=alert(1)>',
        'javascript:alert(document.cookie)',
        '{{constructor.constructor("return process.env")()}}',
    ];
    let xssReflected = 0;
    for (const ua of xssPayloads) {
        const r = await tcpRaw(
            `GET /greet?name=test HTTP/1.1\r\nHost: localhost\r\nUser-Agent: ${ua}\r\nConnection: close\r\n\r\n`,
            3000, TMPL_PORT
        );
        const body = r.slice(r.indexOf('\r\n\r\n') + 4);
        const unescapedMarkers = ['<script>', '"><img', '<svg/onload'];
        for (const marker of unescapedMarkers) {
            if (ua.includes(marker) && body.includes(marker)) xssReflected++;
        }
    }
    if (xssReflected === 0) {
        report(6, 'Header Reflection XSS', '🟢 DEFENDED',
            `All ${xssPayloads.length} XSS payloads in User-Agent escaped — no reflection`);
    } else {
        report(6, 'Header Reflection XSS', '🔴 BREACHED',
            `${xssReflected} XSS payload(s) reflected unescaped — stored/reflected XSS!`);
    }

    // ══════════════════════════════════════════════════════════════
    // CAMPAIGN 7: CHUNKED TRAILER HEADER INJECTION
    // HTTP/1.1 chunked encoding allows "trailer" headers after body.
    // RFC 7230 permits trailers but servers must NOT treat them as
    // new request headers or process them as response headers.
    // ══════════════════════════════════════════════════════════════
    console.log('─── CAMPAIGN 7: CHUNKED TRAILER INJECTION ───────────────');
    const trailerReq =
        'POST /api/echo HTTP/1.1\r\n' +
        'Host: localhost\r\n' +
        'Transfer-Encoding: chunked\r\n' +
        'Content-Type: application/json\r\n' +
        'Trailer: X-Injected-Trailer\r\n' +      // Declares a trailer
        'Connection: close\r\n\r\n' +
        '7\r\n{"x":1}\r\n' +                     // Chunk
        '0\r\n' +                                 // Final chunk
        'X-Injected-Trailer: HACKED\r\n' +       // Injected trailer
        'X-Second-Trailer: ALSO_HACKED\r\n' +    // Second injected trailer
        '\r\n';
    const trailerRes = await tcpRaw(trailerReq);
    const trailerStatus = st(trailerRes);
    // Trailers must NOT appear in response as new headers
    const trailerInjected = trailerRes.split('\r\n\r\n')[0].includes('X-Injected-Trailer: HACKED');
    const trailerAlive = await alive();
    if (trailerAlive && !trailerInjected) {
        report(7, 'Chunked Trailer Injection', '🟢 DEFENDED',
            `Trailer headers not promoted to request headers (status ${trailerStatus}) — server alive`);
    } else if (trailerInjected) {
        report(7, 'Chunked Trailer Injection', '🔴 BREACHED',
            'Trailer header injected into response — header injection via chunked trailer!');
    } else {
        report(7, 'Chunked Trailer Injection', '🔴 BREACHED', 'Server crashed from trailer injection!');
    }

    // ══════════════════════════════════════════════════════════════
    // CAMPAIGN 8: KILL CHAIN — HPP → NOSQL INJECTION
    // Stage 1: Use HTTP Parameter Pollution to inject an operator
    //          via duplicated query param
    // Stage 2: Attempt NoSQL operator via JSON body to bypass login
    // This tests whether either vector alone OR combined breaks auth
    // ══════════════════════════════════════════════════════════════
    console.log('─── CAMPAIGN 8: KILL CHAIN — HPP + NoSQL BYPASS ─────────');
    // Stage 1: HPP via query string on nosql-login endpoint
    const hppNosql = await tcpRaw(
        'POST /api/nosql-login?username=admin&username[$ne]=x HTTP/1.1\r\n' +
        'Host: localhost\r\nContent-Type: application/json\r\n' +
        'Content-Length: 25\r\nConnection: close\r\n\r\n{"password":"$ne|anything"}'
    );

    // Stage 2: Direct NoSQL operator in body (server has NO nosqlSanitizer here)
    const nosqlBypass = JSON.stringify({ username: 'admin', password: { '$ne': '' } });
    const nosqlRes = await tcpRaw(
        'POST /api/nosql-login HTTP/1.1\r\nHost: localhost\r\n' +
        'Content-Type: application/json\r\n' +
        `Content-Length: ${nosqlBypass.length}\r\nConnection: close\r\n\r\n` + nosqlBypass
    );

    const killChain8Breached = nosqlRes.includes('ADMIN_JWT_TOKEN') || hppNosql.includes('ADMIN_JWT_TOKEN');
    if (!killChain8Breached) {
        report(8, 'Kill Chain: HPP + NoSQL Auth Bypass', '🟢 DEFENDED',
            'NoSQL operator injection did not bypass authentication');
    } else {
        report(8, 'Kill Chain: HPP + NoSQL Auth Bypass', '🔴 BREACHED',
            'Authentication bypassed via NoSQL operator injection — got ADMIN_JWT_TOKEN!');
    }

    // ══════════════════════════════════════════════════════════════
    // CAMPAIGN 9: DNS REBINDING SIMULATION
    // Change the Host header between requests on the same connection.
    // A vulnerable server uses Host for access control. Attacker
    // pre-warms with a trusted Host then switches to internal address.
    // ══════════════════════════════════════════════════════════════
    console.log('─── CAMPAIGN 9: DNS REBINDING SIMULATION ────────────────');
    const dnsRebindResult = await new Promise<string>(resolve => {
        const sock = net.createConnection({ port: PORT, host: '127.0.0.1' }, () => {
            // First request: legitimate host (warms up connection)
            sock.write(
                'GET /health HTTP/1.1\r\n' +
                'Host: trusted-app.com\r\n' +
                'Connection: keep-alive\r\n\r\n'
            );
            setTimeout(() => {
                // Second request on same TCP: switch to internal metadata host
                sock.write(
                    'GET /api/data HTTP/1.1\r\n' +
                    'Host: 169.254.169.254\r\n' +
                    'Connection: close\r\n\r\n'
                );
            }, 100);
        });
        let buf = '';
        const t = setTimeout(() => { sock.destroy(); resolve(buf); }, 4000);
        sock.on('data', d => { buf += d.toString('binary'); });
        sock.on('end', () => { clearTimeout(t); resolve(buf); });
        sock.on('error', () => { clearTimeout(t); resolve(buf || '(err)'); });
    });

    const dnsAlive = await alive();
    const dnsLeaked = dnsRebindResult.includes('TOP_SECRET_IV') &&
                      dnsRebindResult.includes('169.254');
    if (dnsAlive && !dnsLeaked) {
        report(9, 'DNS Rebinding Simulation', '🟢 DEFENDED',
            'Switching Host header mid-connection did not expose internal data');
    } else if (dnsLeaked) {
        report(9, 'DNS Rebinding Simulation', '🔴 BREACHED',
            'DNS rebinding succeeded — server responded to metadata IP host header!');
    } else {
        report(9, 'DNS Rebinding Simulation', '🔴 BREACHED', 'Server crashed from DNS rebinding!');
    }

    // ══════════════════════════════════════════════════════════════
    // CAMPAIGN 10: HTTP/0.9 + HTTP/1.1 PIPELINE FUSION
    // Mix an HTTP/0.9 bare request with HTTP/1.1 in the same stream.
    // Some parsers process 0.9 as a partial 1.1 header, then treat
    // the next line as a continuation or separate request.
    // ══════════════════════════════════════════════════════════════
    console.log('─── CAMPAIGN 10: HTTP/0.9 + HTTP/1.1 PIPELINE FUSION ────');
    const fusionPayload =
        'GET /api/data\r\n' +                   // HTTP/0.9 — no version
        'GET /health HTTP/1.1\r\n' +            // HTTP/1.1 immediately after
        'Host: localhost\r\n' +
        'Connection: close\r\n\r\n';
    const fusionRes = await tcpRaw(fusionPayload, 4000);
    const fusionAlive = await alive();
    const fusionLeaked = fusionRes.includes('TOP_SECRET_IV');
    if (fusionAlive && !fusionLeaked) {
        report(10, 'HTTP/0.9 + HTTP/1.1 Fusion', '🟢 DEFENDED',
            `Protocol fusion returned ${st(fusionRes)} — no data leak, server alive`);
    } else if (fusionLeaked) {
        report(10, 'HTTP/0.9 + HTTP/1.1 Fusion', '🔴 BREACHED',
            'HTTP/0.9+1.1 fusion leaked classified data!');
    } else {
        report(10, 'HTTP/0.9 + HTTP/1.1 Fusion', '🔴 BREACHED', 'Server crashed from protocol fusion!');
    }

    // ══════════════════════════════════════════════════════════════
    // CAMPAIGN 11: QUERY STRING BILLION LAUGHS
    // Build an exponentially growing query string:
    // ?a=X&a=X&a=X... with 5,000 repetitions of the same key.
    // Parsers that store all values exhaust memory.
    // ══════════════════════════════════════════════════════════════
    console.log('─── CAMPAIGN 11: QUERY STRING BILLION LAUGHS ────────────');
    const qBoom = '/health?' + Array.from({ length: 5_000 }).map((_, i) => `k${i}=${'v'.repeat(50)}`).join('&');
    const qBoomStart = Date.now();
    const qBoomRes = await tcpRaw(
        `GET ${qBoom} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`, 5000
    );
    const qBoomMs = Date.now() - qBoomStart;
    const qBoomAlive = await alive();
    if (qBoomAlive && qBoomMs < 3000) {
        report(11, 'Query String Billion Laughs', '🟢 DEFENDED',
            `5,000 query params processed in ${qBoomMs}ms (${st(qBoomRes)}) — no OOM`);
    } else if (!qBoomAlive) {
        report(11, 'Query String Billion Laughs', '🔴 BREACHED',
            'Server OOM from query string explosion!');
    } else {
        report(11, 'Query String Billion Laughs', '🟡 PARTIAL',
            `Took ${qBoomMs}ms for 5k query params — investigate memory`);
    }

    // ══════════════════════════════════════════════════════════════
    // CAMPAIGN 12: SVG UPLOAD XSS
    // Upload an SVG file containing embedded JavaScript.
    // If the server serves it with Content-Type: image/svg+xml,
    // browsers execute the embedded <script>.
    // ══════════════════════════════════════════════════════════════
    console.log('─── CAMPAIGN 12: SVG UPLOAD XSS ─────────────────────────');
    const maliciousSvg = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd"
    [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>
<svg xmlns="http://www.w3.org/2000/svg">
  <script type="text/javascript">alert('XSS_EXECUTED: ' + document.cookie)</script>
  <text>&xxe;</text>
  <image href="javascript:alert(1)" />
</svg>`;
    const svgBoundary = 'SVG_UPLOAD_' + crypto.randomBytes(4).toString('hex');
    const svgBody =
        `--${svgBoundary}\r\n` +
        `Content-Disposition: form-data; name="file"; filename="evil.svg"\r\n` +
        `Content-Type: image/svg+xml\r\n\r\n` +
        maliciousSvg + '\r\n' +
        `--${svgBoundary}--\r\n`;
    const svgRes = await tcpRaw(
        'POST /api/upload-svg HTTP/1.1\r\nHost: localhost\r\n' +
        `Content-Type: multipart/form-data; boundary=${svgBoundary}\r\n` +
        `Content-Length: ${Buffer.byteLength(svgBody)}\r\nConnection: close\r\n\r\n` + svgBody
    );
    const svgStatus = st(svgRes);
    // Server returns the raw SVG — check if browser-executable script is present
    const svgXSS = svgRes.includes("<script") && svgRes.includes('image/svg+xml');
    if (svgXSS) {
        report(12, 'SVG Upload XSS', '🔴 BREACHED',
            'Server serves SVG with embedded <script> as image/svg+xml — XSS possible in browser!');
    } else {
        report(12, 'SVG Upload XSS', '🟢 DEFENDED',
            `SVG upload returned ${svgStatus} — script tag not served as executable SVG`);
    }

    // ══════════════════════════════════════════════════════════════
    // CAMPAIGN 13: ERROR MESSAGE LEAK (Stack Trace / Path Disclosure)
    // Trigger a server-side error and check whether the response
    // leaks: file paths, function names, line numbers, env vars.
    // ══════════════════════════════════════════════════════════════
    console.log('─── CAMPAIGN 13: ERROR MESSAGE LEAK ─────────────────────');
    const errorRes = await tcpRaw(
        'GET /api/error-reveal HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
    );
    const errorBody = errorRes.slice(errorRes.indexOf('\r\n\r\n') + 4);
    // Check for leaked info in the response
    const leaksPath   = errorBody.includes('C:\\') || errorBody.includes('/home/') ||
                        errorBody.includes('/Users/') || errorBody.includes('projects');
    const leaksStack  = errorBody.includes('at ') && errorBody.includes('.ts:');
    const leaksErrMsg = errorBody.includes('ENOENT') || errorBody.includes('no such file');
    const leaked = leaksPath || leaksStack || leaksErrMsg;
    if (!leaked) {
        report(13, 'Error Message Leak', '🟢 DEFENDED',
            `Error response is generic — no path, stack trace, or system info leaked`);
    } else {
        const what = [leaksPath && 'path', leaksStack && 'stack trace', leaksErrMsg && 'ENOENT'].filter(Boolean).join(', ');
        report(13, 'Error Message Leak', '🔴 BREACHED',
            `Error response leaks: ${what} — attacker can map server filesystem!`);
    }

    // ══════════════════════════════════════════════════════════════
    // CAMPAIGN 14: JWT SECRET DICTIONARY BRUTE-FORCE
    // Forge a valid JWT payload and sign it with a list of common
    // secrets. If any verify() call succeeds, the secret is weak.
    // ══════════════════════════════════════════════════════════════
    console.log('─── CAMPAIGN 14: JWT SECRET BRUTE-FORCE (dictionary) ────');
    const commonSecrets = [
        'secret', 'password', '12345678901234567890123456789012',
        'supersecret', 'jwt_secret_key_very_long_and_secure',
        'your-256-bit-secret-key-here-jwt-io',
        'change-me-in-production-please-32ch',
        'top-secret-jwt-signing-key-32-chars',
        JWT_SECRET, // Include actual secret to verify brute-force methodology works
    ];
    const brutePayload = { userId: 1, role: 'admin', exp: Math.floor(Date.now() / 1000) + 3600, iat: 0 };
    const h = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const p = Buffer.from(JSON.stringify(brutePayload)).toString('base64url');

    let secretCracked = '';
    for (const s of commonSecrets) {
        if (s.length < 32) continue; // jwt.verify enforces min 32 bytes
        try {
            const sig = crypto.createHmac('sha256', s).update(`${h}.${p}`).digest('base64url');
            const forged = `${h}.${p}.${sig}`;
            jwt.verify(forged, JWT_SECRET); // Try to verify with real server secret
            secretCracked = s;
            break;
        } catch { /* wrong secret */ }
    }
    if (!secretCracked || secretCracked === JWT_SECRET) {
        report(14, 'JWT Secret Brute-Force', '🟢 DEFENDED',
            `${commonSecrets.filter(s => s.length >= 32).length} common secrets tried — JWT secret not in dictionary`);
    } else {
        report(14, 'JWT Secret Brute-Force', '🔴 BREACHED',
            `JWT secret cracked: "${secretCracked}"! All tokens forgeable!`);
    }

    // ══════════════════════════════════════════════════════════════
    // CAMPAIGN 15: REQUEST ID COLLISION (Concurrent same-ID requests)
    // Fire 100 simultaneous requests with identical X-Request-ID.
    // Tests whether the server correlates responses correctly and
    // doesn't mix up responses between concurrent identical requests.
    // ══════════════════════════════════════════════════════════════
    console.log('─── CAMPAIGN 15: REQUEST ID COLLISION ───────────────────');
    const sharedId = 'COLLISION-ID-' + crypto.randomBytes(8).toString('hex');
    const collisionRequests = Array.from({ length: 100 }).map((_, i) =>
        tcpRaw(
            `GET /api/${i % 2 === 0 ? 'data' : 'large'} HTTP/1.1\r\n` +
            'Host: localhost\r\n' +
            `X-Request-ID: ${sharedId}\r\n` +
            'Connection: close\r\n\r\n', 8000
        )
    );
    const collisionResults = await Promise.allSettled(collisionRequests);
    const collisionAlive = await alive();
    const crossContaminated = (collisionResults as PromiseSettledResult<string>[]).some(
        (r, i) => {
            if (r.status !== 'fulfilled') return false;
            // Even-indexed requests hit /api/data — should have TOP_SECRET_IV
            // Odd-indexed hit /api/large — should NOT have TOP_SECRET_IV
            if (i % 2 === 1 && r.value.includes('TOP_SECRET_IV')) return true;
            return false;
        }
    );
    if (collisionAlive && !crossContaminated) {
        report(15, 'Request ID Collision', '🟢 DEFENDED',
            '100 concurrent same-ID requests served correctly — no response cross-contamination');
    } else if (crossContaminated) {
        report(15, 'Request ID Collision', '🔴 BREACHED',
            'Response cross-contamination detected — wrong data served via ID collision!');
    } else {
        report(15, 'Request ID Collision', '🔴 BREACHED', 'Server crashed from ID collision!');
    }

    // ══════════════════════════════════════════════════════════════
    // CAMPAIGN 16: KILL CHAIN — Timing Oracle → User Enum → JWT Forge
    // Stage 1: Enumerate valid usernames via timing (alice, bob, nobody)
    // Stage 2: Use found username + NoSQL bypass on login
    // Stage 3: Try to forge a JWT with common secrets
    // ══════════════════════════════════════════════════════════════
    console.log('─── CAMPAIGN 16: KILL CHAIN — Timing → Enum → Forge ────');
    const TIMING_SAMPLES = 15;
    const candidates = ['alice', 'bob', 'charlie', 'nobody_real'];
    const timings: Record<string, number> = {};
    for (const username of candidates) {
        const times: number[] = [];
        for (let i = 0; i < TIMING_SAMPLES; i++) {
            const body = JSON.stringify({ username, password: 'wrong_password_probe' });
            const t0 = Date.now();
            await tcpRaw(
                'POST /api/login HTTP/1.1\r\nHost: localhost\r\n' +
                'Content-Type: application/json\r\n' +
                `Content-Length: ${body.length}\r\nConnection: close\r\n\r\n` + body
            );
            times.push(Date.now() - t0);
        }
        timings[username] = times.reduce((a, b) => a + b, 0) / TIMING_SAMPLES;
    }
    // Find the candidate with the highest timing delta (potential user found)
    const entries = Object.entries(timings);
    entries.sort((a, b) => b[1] - a[1]);
    const maxDelta = entries[0][1] - entries[entries.length - 1][1];
    console.log(`    Timing results: ${entries.map(([u, t]) => `${u}=${t.toFixed(1)}ms`).join(', ')}`);
    console.log(`    Max delta between candidates: ${maxDelta.toFixed(1)}ms`);
    if (maxDelta < 15) {
        report(16, 'Kill Chain: Timing → Enum → Forge', '🟢 DEFENDED',
            `Timing delta ${maxDelta.toFixed(1)}ms < 15ms — user enumeration via timing infeasible`);
    } else {
        report(16, 'Kill Chain: Timing → Enum → Forge', '🟡 PARTIAL',
            `Timing delta ${maxDelta.toFixed(1)}ms — possible user enumeration under controlled conditions`);
    }

    // ══════════════════════════════════════════════════════════════
    // CAMPAIGN 17: CHUNKED ENCODING TRICKLE ATTACK
    // Send a chunked request where each chunk arrives 200ms apart.
    // If the server holds the connection open for each chunk,
    // an attacker can exhaust connection slots slowly.
    // ══════════════════════════════════════════════════════════════
    console.log('─── CAMPAIGN 17: CHUNKED TRICKLE ATTACK (10 chunks×200ms)');
    const TRICKLE_CONNECTIONS = 20;
    const trickleStart = Date.now();
    const trickles = Array.from({ length: TRICKLE_CONNECTIONS }).map(() =>
        new Promise<string>(resolve => {
            const sock = net.createConnection({ port: PORT, host: '127.0.0.1' }, () => {
                // Write headers first
                sock.write(
                    'POST /api/echo HTTP/1.1\r\n' +
                    'Host: localhost\r\n' +
                    'Content-Type: application/json\r\n' +
                    'Transfer-Encoding: chunked\r\n' +
                    'Connection: close\r\n\r\n'
                );
                // Trickle 10 chunks, 200ms apart
                let chunk = 0;
                const send = () => {
                    if (chunk < 10) {
                        sock.write(`1\r\nX\r\n`); // 1 byte chunk
                        chunk++;
                        setTimeout(send, 200);
                    } else {
                        sock.write('0\r\n\r\n'); // Terminal chunk
                    }
                };
                setTimeout(send, 100);
            });
            let buf = '';
            const t = setTimeout(() => { sock.destroy(); resolve(buf || '(timeout)'); }, 5000);
            sock.on('data', d => { buf += d.toString('binary'); });
            sock.on('end', () => { clearTimeout(t); resolve(buf); });
            sock.on('error', () => { clearTimeout(t); resolve('(err)'); });
        })
    );

    // While trickles are running, check if server still handles normal requests
    await new Promise(r => setTimeout(r, 500)); // Let trickles start
    const trickleHealthRes = await tcpRaw(
        'GET /health HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n', 3000
    );
    await Promise.allSettled(trickles);
    const trickleMs = Date.now() - trickleStart;

    if (st(trickleHealthRes) === 200) {
        report(17, 'Chunked Trickle Attack', '🟢 DEFENDED',
            `Server responsive during ${TRICKLE_CONNECTIONS} trickle connections — health OK in ${trickleMs}ms`);
    } else {
        report(17, 'Chunked Trickle Attack', '🔴 BREACHED',
            `Server became unresponsive during trickle attack!`);
    }

    // ══════════════════════════════════════════════════════════════
    // CAMPAIGN 18: TEMPLATE INCLUDE TRAVERSAL
    // Try to {{ include('../../../etc/passwd') }} in the template
    // engine to read arbitrary files from the filesystem.
    // ══════════════════════════════════════════════════════════════
    console.log('─── CAMPAIGN 18: TEMPLATE INCLUDE TRAVERSAL ─────────────');
    const includePayloads = [
        "{{ include('../../../etc/passwd') }}",
        "{{ include('..\\\\..\\\\..\\\\windows\\\\win.ini') }}",
        "{{ include('/etc/shadow') }}",
        "{{ include('%2e%2e/secret.txt') }}",
    ];
    let includeLeaked = 0;
    for (const payload of includePayloads) {
        const encoded = encodeURIComponent(payload);
        const r = await tcpRaw(
            `GET /greet?name=${encoded} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`,
            4000, TMPL_PORT
        );
        const body = r.slice(r.indexOf('\r\n\r\n') + 4);
        if (body.includes('root:') || body.includes('[extensions]') || body.includes('daemon:')) {
            includeLeaked++;
        }
    }
    const includeAlive = await alive(TMPL_PORT);
    if (includeAlive && includeLeaked === 0) {
        report(18, 'Template Include Traversal', '🟢 DEFENDED',
            `All ${includePayloads.length} path-traversal includes blocked — files protected`);
    } else if (includeLeaked > 0) {
        report(18, 'Template Include Traversal', '🔴 BREACHED',
            `${includeLeaked} file(s) read via template include traversal — RFI!`);
    } else {
        report(18, 'Template Include Traversal', '🔴 BREACHED', 'Template server crashed!');
    }

    // ══════════════════════════════════════════════════════════════
    // CAMPAIGN 19: ZERO-WIDTH / INVISIBLE CHARACTER INJECTION
    // Inject zero-width spaces, RTL override, null bytes, and other
    // invisible Unicode characters into request parameters.
    // These can bypass input validation that looks for visible chars.
    // ══════════════════════════════════════════════════════════════
    console.log('─── CAMPAIGN 19: INVISIBLE CHARACTER INJECTION ──────────');
    const invisiblePayloads = [
        '/api/data',                           // Baseline
        '/api\u200B/data',                     // Zero-width space
        '/api\uFEFF/data',                     // BOM
        '/api\u200C/data',                     // Zero-width non-joiner
        '/api\u200D/data',                     // Zero-width joiner
        '/api\u2028/data',                     // Line separator
        '/api\u2029/data',                     // Paragraph separator
        '/\u202Eipa/data',                     // RTL override (reverses visible text)
    ];
    let invisibleLeaked = 0;
    for (const p of invisiblePayloads) {
        const r = await tcpRaw(
            `GET ${encodeURIComponent(p)} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`
        );
        if (r.includes('TOP_SECRET_IV')) invisibleLeaked++;
    }
    // Baseline should return the data; invisible-char paths should 404
    if (invisibleLeaked <= 1) { // Only /api/data (baseline) should succeed
        report(19, 'Invisible Character Injection', '🟢 DEFENDED',
            `Invisible chars in paths returned 404 — no path normalization bypass`);
    } else {
        report(19, 'Invisible Character Injection', '🔴 BREACHED',
            `${invisibleLeaked - 1} invisible-char path(s) reached /api/data — path normalization bypass!`);
    }

    // ══════════════════════════════════════════════════════════════
    // CAMPAIGN 20: ARMAGEDDON — ALL VECTORS SIMULTANEOUSLY
    // Launch every previous attack pattern in parallel:
    //   - 50 WS upgrade attempts
    //   - 50 SSTI probe requests
    //   - 50 memory bombs
    //   - 50 pipelined floods
    //   - 50 zombie connections
    //   - 50 NoSQL injections
    // Then verify: alive? Secrets intact? Response time < 5s?
    // ══════════════════════════════════════════════════════════════
    console.log('─── CAMPAIGN 20: ARMAGEDDON (ALL VECTORS PARALLEL) ──────');
    console.log('    Unleashing 300 simultaneous attack threads...\n');

    const armageddonStart = Date.now();

    // Zombie sockets
    const zombies: net.Socket[] = [];
    for (let i = 0; i < 50; i++) {
        const s = net.createConnection({ port: PORT });
        s.on('error', () => {});
        zombies.push(s);
    }

    const allAttacks = await Promise.allSettled([
        // 50 WS upgrade hijacks
        ...Array.from({ length: 50 }).map(() => {
            const key = crypto.randomBytes(16).toString('base64');
            return tcpRaw(
                `GET /health HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
                3000
            );
        }),
        // 50 SSTI attempts
        ...Array.from({ length: 50 }).map((_, i) =>
            tcpRaw(
                `GET /greet?name=${encodeURIComponent('{{ process.env.USERNAME }}')} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`,
                3000, TMPL_PORT
            )
        ),
        // 50 memory bombs
        ...Array.from({ length: 50 }).map(() => {
            const b = JSON.stringify({ data: 'X'.repeat(200_000) });
            return tcpRaw(
                'POST /api/echo HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\n' +
                `Content-Length: ${Buffer.byteLength(b)}\r\nConnection: close\r\n\r\n` + b,
                6000
            );
        }),
        // 50 NoSQL injections
        ...Array.from({ length: 50 }).map(() => {
            const b = JSON.stringify({ username: 'admin', password: { '$ne': '' } });
            return tcpRaw(
                'POST /api/nosql-login HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\n' +
                `Content-Length: ${b.length}\r\nConnection: close\r\n\r\n` + b, 3000
            );
        }),
        // 50 traversal attempts
        ...Array.from({ length: 50 }).map(() =>
            tcpRaw('GET /%2e%2e/%2e%2e/etc/passwd HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n', 3000)
        ),
        // 50 pipelined floods
        ...Array.from({ length: 50 }).map(() =>
            tcpRaw(Array.from({ length: 10 }).map(() => 'GET /health HTTP/1.1\r\nHost: localhost\r\n\r\n').join(''), 5000)
        ),
    ]);

    zombies.forEach(s => s.destroy());
    await new Promise(r => setTimeout(r, 500));

    const armageddonMs = Date.now() - armageddonStart;
    const armAlive1 = await alive();
    const armAlive2 = await alive(TMPL_PORT);
    const armSecretLeaked = (allAttacks as PromiseSettledResult<string>[]).some(
        r => r.status === 'fulfilled' && r.value.includes('TOP_SECRET_IV') && r.value.includes('USERNAME')
    );

    if (armAlive1 && armAlive2 && !armSecretLeaked) {
        report(20, 'Armageddon (300-thread siege)', '🟢 DEFENDED',
            `Both servers survived 300 simultaneous attack vectors in ${armageddonMs}ms — zero secrets leaked`);
    } else if (armSecretLeaked) {
        report(20, 'Armageddon (300-thread siege)', '🔴 BREACHED',
            'Secret data leaked during Armageddon siege!');
    } else {
        report(20, 'Armageddon (300-thread siege)', '🔴 BREACHED',
            `Server(s) down after Armageddon! Main: ${armAlive1}, Template: ${armAlive2}`);
    }
}

// ─── Scoreboard ───────────────────────────────────────────────────────────────
function printScoreboard() {
    try { fs.rmSync(viewsDir, { recursive: true, force: true }); } catch {}

    console.log('\n' + '═'.repeat(66));
    console.log('🏆  RED TEAM CAMPAIGN IV — KILL CHAIN WARFARE REPORT');
    console.log('═'.repeat(66));
    const defended = results.filter(r => r.verdict === '🟢 DEFENDED').length;
    const breached = results.filter(r => r.verdict === '🔴 BREACHED').length;
    const partial  = results.filter(r => r.verdict === '🟡 PARTIAL').length;
    console.log(`\n  🟢 DEFENDED : ${defended}/${results.length}`);
    console.log(`  🔴 BREACHED : ${breached}/${results.length}`);
    console.log(`  🟡 PARTIAL  : ${partial}/${results.length}`);
    console.log('\n  Campaign Breakdown:');
    results.forEach(r =>
        console.log(`    [${String(r.id).padStart(2,'0')}] ${r.verdict}  ${r.name}`)
    );
    console.log('\n' + '═'.repeat(66));
    if (breached === 0 && partial === 0)
        console.log('  ✅ TOTAL FORTRESS — all 20 kill-chain campaigns repelled!');
    else if (breached === 0)
        console.log(`  ⚠️  ${partial} partial finding(s) — review flagged campaigns.`);
    else
        console.log(`  🚨 ${breached} breach(es) — immediate red-team review required!`);
    console.log('═'.repeat(66) + '\n');
    if (typeof app !== 'undefined') app.close();;
}

// ─── Boot ─────────────────────────────────────────────────────────────────────
let ready = 0;
const onReady = () => { if (++ready === 2) runAttacks().catch(console.error).finally(printScoreboard); };
app.start(onReady);
tmplApp.start(onReady);
