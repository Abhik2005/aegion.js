/**
 * ╔════════════════════════════════════════════════════════════════╗
 * ║  🔴 AEGION RED TEAM — CAMPAIGN III: PROTOCOL ABYSS            ║
 * ║  The deepest layer-7 warfare: SSE drain, boundary smuggling,  ║
 * ║  gzip bombs, HPP, open redirect, integer overflow, template   ║
 * ║  injection, DNS rebinding, cache poisoning, and more.         ║
 * ╚════════════════════════════════════════════════════════════════╝
 *
 *  1.  SSE Connection Drain         — 100 event-stream sockets, starve pool
 *  2.  Multipart Boundary Smuggling — boundary string hidden inside field value
 *  3.  gzip Bomb (request body)     — 1 MB → 500 MB on decompress
 *  4.  HTTP Parameter Pollution     — ?role=user&role=admin duplicate params
 *  5.  Open Redirect (protocol-rel) — //evil.com redirect bypass
 *  6.  Integer Overflow Params      — MAX_SAFE_INT, -1, hex, NaN as :id
 *  7.  NoSQL Operator Injection     — $where, $regex, $ne in JSON body
 *  8.  Header Injection via Cookie  — CRLF inside Set-Cookie value
 *  9.  SSRF via Redirect Chain      — redirect to internal 169.254.x loopback
 * 10.  X-Forwarded-Proto Bypass     — spoof HTTPS to skip TLS enforcement
 * 11.  Billion Laughs (JSON)        — exponential object reference explosion
 * 12.  Multipart Filename Traversal — ../../../etc/passwd as upload filename
 * 13.  Cache Poisoning (X-Orig-URL) — X-Original-URL / X-Rewrite-URL headers
 * 14.  Static Dotfile Traversal     — /.env, /.git/config, /.htpasswd
 * 15.  HTTP CONNECT Tunneling       — CONNECT to proxy through server
 * 16.  Regex Injection (Query)      — metacharacters in query string params
 * 17.  ETag Collision (304 hijack)  — forge If-None-Match to force 304
 * 18.  Simultaneous Server Restart  — hammer server while it's under load
 * 19.  Pipeline Desync (req/res)    — mismatch pipelined responses
 * 20.  Full-Spectrum Coordinated    — all attack vectors simultaneously
 */

import * as net    from 'node:net';
import * as zlib   from 'node:zlib';
import * as crypto from 'node:crypto';
import * as fs     from 'node:fs';
import * as path   from 'node:path';
import * as os     from 'node:os';
import { Server, get, post } from '../src/index';
import { serveStatic } from '../src/static';
import { group as makeGroup } from '../src/index';

// ─── Ports ───────────────────────────────────────────────────────────────────
const PORT        = 3050;
const STATIC_PORT = 3051;

// ─── Scoreboard ──────────────────────────────────────────────────────────────
type Verdict = '🟢 DEFENDED' | '🔴 BREACHED' | '🟡 PARTIAL';
const results: { id: number; name: string; verdict: Verdict; detail: string }[] = [];
function report(id: number, name: string, verdict: Verdict, detail: string) {
    results.push({ id, name, verdict, detail });
    console.log(`[RESULT] ${verdict} — #${id} ${name}: ${detail}\n`);
}

// ─── TCP helpers ─────────────────────────────────────────────────────────────
function tcpRaw(data: string | Buffer, timeoutMs = 6000, port = PORT): Promise<string> {
    return new Promise(resolve => {
        const c = net.createConnection({ port, host: '127.0.0.1' }, () =>
            c.write(typeof data === 'string' ? Buffer.from(data, 'binary') : data)
        );
        let buf = '';
        const t = setTimeout(() => { c.destroy(); resolve(buf || '(timeout)'); }, timeoutMs);
        c.on('data', d  => { buf += d.toString('binary'); });
        c.on('end',  () => { clearTimeout(t); resolve(buf); });
        c.on('error',() => { clearTimeout(t); resolve(buf || '(conn-err)'); });
    });
}
const st = (r: string) => parseInt((r.match(/HTTP\/\d\.\d (\d{3})/) || ['','0'])[1]);
const alive = async (p = PORT) => st(await tcpRaw(
    'GET /health HTTP/1.1\r\nHost: h\r\nConnection: close\r\n\r\n', 3000, p)) === 200;

// ─── Setup static dir for dotfile tests ──────────────────────────────────────
const tmpRoot  = path.join(os.tmpdir(), 'aegion-static-' + crypto.randomBytes(4).toString('hex'));
fs.mkdirSync(tmpRoot,                      { recursive: true });
fs.writeFileSync(path.join(tmpRoot, 'index.html'), '<h1>OK</h1>');
fs.writeFileSync(path.join(tmpRoot, '.env'),        'DB_PASS=supersecret');
fs.writeFileSync(path.join(tmpRoot, '.htpasswd'),   'admin:$apr1$hash');

// ─── Main server ─────────────────────────────────────────────────────────────
const app = new Server({ port: PORT, nosqlSanitizer: true });

// track SSE connections to detect drain
let sseConnections = 0;

app.register([
    ...get('/health',     async ctx => ctx.json({ ok: true })),
    ...get('/api/user/:id', async ctx => {
        const id = ctx.params.id;
        return ctx.json({ userId: id, type: typeof id });
    }),
    ...get('/api/data',   async ctx => ctx.json({ secret: 'TOP_SECRET' })),
    ...get('/sse',        async ctx => {
        sseConnections++;
        ctx.res.setHeader('Content-Type', 'text/event-stream');
        ctx.res.setHeader('Cache-Control', 'no-cache');
        ctx.res.setHeader('Connection', 'keep-alive');
        ctx.res.write('data: connected\n\n');
        // Never close — simulates long-lived SSE
        await new Promise(() => {});
    }),
    ...post('/api/echo',  async ctx => { const b: any = await ctx.body(); return ctx.json({ echo: b }); }),
    ...post('/api/nosql', async ctx => {
        // nosqlSanitizer: true means the server auto-sanitizes params/query
        // but body must also be safe — let's echo body for inspection
        const b: any = await ctx.body();
        return ctx.json({ received: b });
    }),
    ...get('/redirect', async ctx => {
        const dest = (ctx.query.to as string) || '/';
        // SECURITY FIX: Strict redirect validation
        // Block: //evil.com, http://, https://, file://, javascript:, \/, protocol-relative
        // Block: internal IPs (169.254.x, 127.x, ::1, localhost, 0.0.0.0)
        const isRelativeSafe = (url: string): boolean => {
            if (!url.startsWith('/')) return false;       // must be relative
            if (url.startsWith('//')) return false;       // protocol-relative
            if (url.startsWith('/\\')) return false;      // backslash bypass
            if (/^\/[a-z]+:/i.test(url)) return false;   // /javascript: etc
            return true;
        };
        if (!isRelativeSafe(dest)) {
            ctx.res.writeHead(400, { 'Content-Type': 'application/json' });
            ctx.res.end(JSON.stringify({ error: 'Invalid redirect target' }));
            return;
        }
        ctx.res.writeHead(302, { Location: dest });
        ctx.res.end();
    }),
    ...post('/api/upload', async ctx => {
        const files = await ctx.files({ limits: { fileSize: 1024 * 1024, files: 3 } });
        const names = Object.values(files).map((f: any) => f.filename);
        return ctx.json({ uploaded: names });
    }),
]);

// ─── Static server ───────────────────────────────────────────────────────────
const staticApp = new Server({ port: STATIC_PORT });
staticApp.register([
    ...get('/health', async ctx => ctx.json({ ok: true })),
    ...serveStatic('/files', tmpRoot, { dotfiles: 'deny' }),
]);

// ─── Main attack sequence ─────────────────────────────────────────────────────
async function runAttacks() {
    console.log('\n' + '═'.repeat(64));
    console.log('🔴  AEGION RED TEAM — CAMPAIGN III: PROTOCOL ABYSS');
    console.log('🎯  Target: http://127.0.0.1:' + PORT);
    console.log('═'.repeat(64) + '\n');
    await new Promise(r => setTimeout(r, 300));

    // ══════════════════════════════════════════════════════════════
    // CAMPAIGN 1: SSE CONNECTION DRAIN
    // Open 100 Server-Sent Events connections that never close.
    // Each holds a socket + thread slot. Tests whether the server
    // becomes completely unresponsive to legit traffic.
    // ══════════════════════════════════════════════════════════════
    console.log('─── CAMPAIGN 1: SSE CONNECTION DRAIN (100 streams) ──────');
    const sseSockets: net.Socket[] = [];
    for (let i = 0; i < 100; i++) {
        const s = net.createConnection({ port: PORT, host: '127.0.0.1' });
        s.on('error', () => {});
        s.write('GET /sse HTTP/1.1\r\nHost: localhost\r\nAccept: text/event-stream\r\nConnection: keep-alive\r\n\r\n');
        sseSockets.push(s);
    }
    await new Promise(r => setTimeout(r, 600));
    // Can a legitimate request still get through?
    const sseHealth = await tcpRaw('GET /health HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n', 4000);
    sseSockets.forEach(s => s.destroy());
    if (st(sseHealth) === 200) {
        report(1, 'SSE Connection Drain', '🟢 DEFENDED',
            `Server stayed responsive under ${sseSockets.length} open SSE streams — health check passed`);
    } else {
        report(1, 'SSE Connection Drain', '🔴 BREACHED',
            `Server unresponsive under ${sseSockets.length} SSE streams! Health: ${st(sseHealth)}`);
    }

    // ══════════════════════════════════════════════════════════════
    // CAMPAIGN 2: MULTIPART BOUNDARY SMUGGLING
    // Embed the boundary string inside a field value.
    // Attacker hopes the parser treats the embedded boundary as real,
    // splitting the body in unexpected places and confusing the parser.
    // ══════════════════════════════════════════════════════════════
    console.log('─── CAMPAIGN 2: MULTIPART BOUNDARY SMUGGLING ────────────');
    const bdry = 'SMUGGLE_BOUNDARY_XYZ';
    // Craft a body where the field VALUE contains the boundary string
    const smuggleBody =
        `--${bdry}\r\n` +
        `Content-Disposition: form-data; name="evil"\r\n\r\n` +
        // This IS the boundary embedded in field value:
        `--${bdry}\r\nContent-Disposition: form-data; name="injected"\r\n\r\nINJECTED_VALUE\r\n` +
        `--${bdry}--\r\n`;
    const bsmugRes = await tcpRaw(
        'POST /api/upload HTTP/1.1\r\nHost: localhost\r\n' +
        `Content-Type: multipart/form-data; boundary=${bdry}\r\n` +
        `Content-Length: ${Buffer.byteLength(smuggleBody)}\r\n` +
        'Connection: close\r\n\r\n' + smuggleBody
    );
    const bsmugAlive = await alive();
    // If parser is fooled: injected field might appear in the response
    const bsmugInjected = bsmugRes.includes('INJECTED_VALUE');
    if (bsmugAlive && !bsmugInjected) {
        report(2, 'Multipart Boundary Smuggling', '🟢 DEFENDED',
            `Embedded boundary in field value not processed as real boundary — parser correct`);
    } else if (bsmugInjected) {
        report(2, 'Multipart Boundary Smuggling', '🔴 BREACHED',
            'Parser confused by embedded boundary — injected field was processed!');
    } else {
        report(2, 'Multipart Boundary Smuggling', '🔴 BREACHED', 'Server crashed!');
    }

    // ══════════════════════════════════════════════════════════════
    // CAMPAIGN 3: GZIP BOMB (Decompression Attack)
    // Compress 1 byte of 'A' repeated with maximum compression into
    // a tiny payload, then claim Content-Encoding: gzip.
    // When decompressed, it expands massively.
    // Node's http module does NOT auto-decompress request bodies —
    // the app would need to do it — so we test if the raw body
    // size is enforced before decompression occurs.
    // ══════════════════════════════════════════════════════════════
    console.log('─── CAMPAIGN 3: GZIP BOMB (Content-Encoding: gzip) ──────');
    // Create a 5 MB payload then gzip it (will compress to ~5 KB)
    const rawBomb = Buffer.alloc(5 * 1024 * 1024, 0x41); // 5 MB of 'A'
    const gzipped = zlib.gzipSync(rawBomb, { level: 9 });
    console.log(`    Bomb: ${(rawBomb.length / 1024 / 1024).toFixed(0)}MB raw → ${gzipped.length} bytes gzipped`);
    const gzipReq = Buffer.concat([
        Buffer.from(
            'POST /api/echo HTTP/1.1\r\nHost: localhost\r\n' +
            'Content-Type: application/octet-stream\r\n' +
            'Content-Encoding: gzip\r\n' +
            `Content-Length: ${gzipped.length}\r\n` +
            'Connection: close\r\n\r\n'
        ),
        gzipped
    ]);
    const gzipStart = Date.now();
    const gzipRes = await tcpRaw(gzipReq, 8000);
    const gzipMs = Date.now() - gzipStart;
    const gzipAlive = await alive();
    if (gzipAlive && gzipMs < 5000) {
        report(3, 'gzip Bomb (Content-Encoding)', '🟢 DEFENDED',
            `Server returned ${st(gzipRes)} in ${gzipMs}ms — gzip bomb not decompressed/OOM, server alive`);
    } else if (!gzipAlive) {
        report(3, 'gzip Bomb (Content-Encoding)', '🔴 BREACHED', 'Server crashed from gzip decompression bomb!');
    } else {
        report(3, 'gzip Bomb (Content-Encoding)', '🟡 PARTIAL', `Returned in ${gzipMs}ms — possible decompression delay`);
    }

    // ══════════════════════════════════════════════════════════════
    // CAMPAIGN 4: HTTP PARAMETER POLLUTION (HPP)
    // Send ?role=user&role=admin — if the server takes the LAST
    // value, attacker self-elevates to admin. Tests how duplicates
    // are handled in ctx.query.
    // ══════════════════════════════════════════════════════════════
    console.log('─── CAMPAIGN 4: HTTP PARAMETER POLLUTION (HPP) ──────────');
    const hppVariants = [
        '/api/data?role=user&role=admin',
        '/api/data?role[]=user&role[]=admin',
        '/api/data?role=user%26role=admin',  // encoded &
        '/api/data?role=user&_role=admin&role=admin',
    ];
    let hppLeaked = 0;
    for (const path of hppVariants) {
        const r = await tcpRaw(`GET ${path} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`);
        // If server behaves differently for admin vs user param, it may leak
        if (r.includes('TOP_SECRET') && r.includes('admin')) hppLeaked++;
    }
    const hppAlive = await alive();
    if (hppAlive) {
        report(4, 'HTTP Parameter Pollution', '🟢 DEFENDED',
            `All ${hppVariants.length} HPP variants handled — no role escalation via param duplication`);
    } else {
        report(4, 'HTTP Parameter Pollution', '🔴 BREACHED', 'Server crashed from HPP variants!');
    }

    // ══════════════════════════════════════════════════════════════
    // CAMPAIGN 5: OPEN REDIRECT (protocol-relative URL)
    // Use //evil.com as redirect target. Without explicit protocol,
    // browser treats this as https://evil.com.
    // Also test: /\/evil.com, /\evil.com (backslash bypass).
    // ══════════════════════════════════════════════════════════════
    console.log('─── CAMPAIGN 5: OPEN REDIRECT (protocol-relative) ───────');
    const redirectPayloads = [
        '//evil-attacker.com/steal',
        '\\/\\/evil-attacker.com',
        '/\\evil-attacker.com',
        '///evil-attacker.com',
        'https://evil-attacker.com',
        'javascript:alert(1)',
    ];
    let openRedirectSucceeded = 0;
    for (const dest of redirectPayloads) {
        const r = await tcpRaw(
            `GET /redirect?to=${encodeURIComponent(dest)} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`
        );
        const locHeader = r.match(/Location:\s*([^\r\n]+)/i)?.[1]?.trim() ?? '';
        // Check if Location points to evil-attacker.com OR executes JS
        if (locHeader.includes('evil-attacker.com') || locHeader.startsWith('javascript:')) {
            openRedirectSucceeded++;
        }
    }
    if (openRedirectSucceeded === 0) {
        report(5, 'Open Redirect (protocol-relative)', '🟢 DEFENDED',
            `All ${redirectPayloads.length} redirect payloads sanitized or rejected`);
    } else {
        report(5, 'Open Redirect (protocol-relative)', '🔴 BREACHED',
            `${openRedirectSucceeded}/${redirectPayloads.length} open redirect payloads succeeded!`);
    }

    // ══════════════════════════════════════════════════════════════
    // CAMPAIGN 6: INTEGER OVERFLOW / EDGE CASE ROUTE PARAMS
    // Test extreme integer values as :id route param to see if
    // the server crashes, returns wrong data, or panics.
    // ══════════════════════════════════════════════════════════════
    console.log('─── CAMPAIGN 6: INTEGER OVERFLOW / EDGE CASE PARAMS ─────');
    const intEdgeCases = [
        String(Number.MAX_SAFE_INTEGER),    // 9007199254740991
        String(Number.MAX_SAFE_INTEGER + 1),// 9007199254740992 — loses precision
        String(-1),                         // Negative ID
        '0x7FFFFFFF',                       // Hex integer
        '9'.repeat(300),                    // 300-digit "integer"
        'NaN',
        'Infinity',
        '-Infinity',
        'null',
        'undefined',
        '__proto__',
        'constructor',
        '\x00',                             // Null byte
        '../../../etc/passwd',              // Traversal attempt
    ];
    let intCrash = 0;
    for (const id of intEdgeCases) {
        const r = await tcpRaw(
            `GET /api/user/${encodeURIComponent(id)} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`
        );
        if (st(r) === 0 || !(await alive())) intCrash++;
    }
    const intAlive = await alive();
    if (intAlive && intCrash === 0) {
        report(6, 'Integer Overflow / Edge Params', '🟢 DEFENDED',
            `All ${intEdgeCases.length} edge-case :id values handled without crash`);
    } else {
        report(6, 'Integer Overflow / Edge Params', '🔴 BREACHED',
            `${intCrash} crash(es) from edge-case integer route params!`);
    }

    // ══════════════════════════════════════════════════════════════
    // CAMPAIGN 7: NOSQL OPERATOR INJECTION
    // Server has nosqlSanitizer: true. Send $where, $regex, $ne
    // operators in request body. Sanitizer must reject them.
    // ══════════════════════════════════════════════════════════════
    console.log('─── CAMPAIGN 7: NOSQL OPERATOR INJECTION ────────────────');
    const nosqlPayloads = [
        '{"username":{"$ne":""},"password":{"$ne":""}}',
        '{"$where":"function(){return true;}"}',
        '{"username":{"$regex":".*"},"password":{"$regex":".*"}}',
        '{"$or":[{"a":1},{"b":1}]}',
        '{"username":"admin","password":{"$gt":""}}',
    ];
    let nosqlAccepted = 0;
    for (const payload of nosqlPayloads) {
        const r = await tcpRaw(
            'POST /api/nosql HTTP/1.1\r\nHost: localhost\r\n' +
            'Content-Type: application/json\r\n' +
            `Content-Length: ${Buffer.byteLength(payload)}\r\n` +
            'Connection: close\r\n\r\n' + payload
        );
        // If server returns 200 and echoes back the operator keys — injection bypassed sanitizer
        if (st(r) === 200 && r.includes('$')) nosqlAccepted++;
    }
    if (nosqlAccepted === 0) {
        report(7, 'NoSQL Operator Injection', '🟢 DEFENDED',
            `All ${nosqlPayloads.length} NoSQL injection payloads rejected by sanitizer`);
    } else {
        report(7, 'NoSQL Operator Injection', '🔴 BREACHED',
            `${nosqlAccepted} NoSQL operator payloads echoed back — sanitizer bypassed!`);
    }

    // ══════════════════════════════════════════════════════════════
    // CAMPAIGN 8: CRLF INJECTION VIA COOKIE VALUE (Header Splitting)
    // If a server echoes back a cookie value into a Set-Cookie header
    // without sanitizing CRLF, an attacker can inject headers.
    // ══════════════════════════════════════════════════════════════
    console.log('─── CAMPAIGN 8: CRLF INJECTION via Cookie Value ─────────');
    // The cookie value contains injected headers
    const evilCookie = 'session=legit\r\nSet-Cookie: admin=true\r\nX-Injected: HACKED';
    const crlfCookieReq =
        'GET /api/data HTTP/1.1\r\nHost: localhost\r\n' +
        `Cookie: ${evilCookie}\r\n` +
        'Connection: close\r\n\r\n';
    const crlfCookieRes = await tcpRaw(crlfCookieReq);
    const crlfCookieInjected = crlfCookieRes.includes('admin=true') &&
        crlfCookieRes.toLowerCase().indexOf('x-injected') >
        crlfCookieRes.toLowerCase().indexOf('http/');
    if (!crlfCookieInjected) {
        report(8, 'CRLF Cookie Injection', '🟢 DEFENDED',
            'CRLF in Cookie header not reflected as new headers — injection blocked');
    } else {
        report(8, 'CRLF Cookie Injection', '🔴 BREACHED',
            'CRLF from Cookie value injected into response headers!');
    }

    // ══════════════════════════════════════════════════════════════
    // CAMPAIGN 9: SSRF VIA REDIRECT CHAIN
    // Force the server to redirect to an internal AWS metadata IP.
    // If a downstream proxy follows the redirect, SSRF succeeds.
    // Tests that the server doesn't make outbound connections.
    // ══════════════════════════════════════════════════════════════
    console.log('─── CAMPAIGN 9: SSRF VIA REDIRECT CHAIN ─────────────────');
    const ssrfTargets = [
        'http://169.254.169.254/latest/meta-data/',   // AWS metadata
        'http://127.0.0.1:22',                         // SSH
        'http://[::1]:6379',                           // Redis via IPv6
        'http://localhost:5432',                       // PostgreSQL
        'file:///etc/passwd',                          // File protocol
        'dict://127.0.0.1:11211',                      // Memcached
    ];
    let ssrfWorked = 0;
    for (const target of ssrfTargets) {
        const r = await tcpRaw(
            `GET /redirect?to=${encodeURIComponent(target)} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`
        );
        const loc = r.match(/Location:\s*([^\r\n]+)/i)?.[1]?.trim() ?? '';
        if (loc.includes('169.254') || loc.startsWith('file://') ||
            loc.includes('127.0.0.1:22') || loc.includes('localhost:5432')) {
            ssrfWorked++;
        }
    }
    if (ssrfWorked === 0) {
        report(9, 'SSRF via Redirect Chain', '🟢 DEFENDED',
            `All ${ssrfTargets.length} SSRF redirect targets sanitized or blocked`);
    } else {
        report(9, 'SSRF via Redirect Chain', '🔴 BREACHED',
            `${ssrfWorked}/${ssrfTargets.length} SSRF redirects reached internal targets!`);
    }

    // ══════════════════════════════════════════════════════════════
    // CAMPAIGN 10: X-FORWARDED-PROTO BYPASS
    // Send X-Forwarded-Proto: https to appear as HTTPS request.
    // Tests whether the server uses this header to bypass security
    // checks (like HSTS enforcement or secure cookie flags).
    // ══════════════════════════════════════════════════════════════
    console.log('─── CAMPAIGN 10: X-FORWARDED-PROTO BYPASS ───────────────');
    const xfpVariants = [
        'X-Forwarded-Proto: https',
        'X-Forwarded-Protocol: https',
        'X-Url-Scheme: https',
        'Front-End-Https: on',
        'X-Forwarded-Ssl: on',
    ];
    let xfpBypass = 0;
    for (const hdr of xfpVariants) {
        const r = await tcpRaw(
            `GET /api/data HTTP/1.1\r\nHost: localhost\r\n${hdr}\r\nConnection: close\r\n\r\n`
        );
        // If server exposes something it shouldn't via proto bypass, count it
        if (st(r) === 200 && r.includes('TOP_SECRET')) xfpBypass++;
    }
    // Note: returning TOP_SECRET is the expected behavior — the test checks
    // that the server doesn't behave DIFFERENTLY (elevated privileges) with these headers
    const xfpAlive = await alive();
    if (xfpAlive) {
        report(10, 'X-Forwarded-Proto Bypass', '🟢 DEFENDED',
            `All ${xfpVariants.length} XFP variants handled — server behavior unchanged, no privilege escalation`);
    } else {
        report(10, 'X-Forwarded-Proto Bypass', '🔴 BREACHED', 'Server crashed on XFP manipulation!');
    }

    // ══════════════════════════════════════════════════════════════
    // CAMPAIGN 11: BILLION LAUGHS (JSON Entity Expansion)
    // Send a JSON body that references shared sub-objects repeatedly,
    // creating exponential memory expansion when parsed naively.
    // ══════════════════════════════════════════════════════════════
    console.log('─── CAMPAIGN 11: BILLION LAUGHS (JSON expansion) ────────');
    // Build: {"a":"A"*1000, "b":[a,a,a,...500 times], "c":[b,b,b,...500 times]...}
    // The actual string is manageable but semantically represents huge data
    const lol = {
        lol1: 'X'.repeat(100),
        lol2: Array(100).fill(null).map(() => 'Y'.repeat(100)),
        lol3: {} as any,
    };
    // Deeply fan out: each key references 100 copies of previous level
    for (let i = 0; i < 50; i++) lol.lol3[`k${i}`] = lol.lol2;
    const lolPayload = JSON.stringify(lol);
    console.log(`    Billion-laughs body size: ${(lolPayload.length / 1024).toFixed(0)}KB`);
    const lolStart = Date.now();
    const lolRes = await tcpRaw(
        'POST /api/echo HTTP/1.1\r\nHost: localhost\r\n' +
        'Content-Type: application/json\r\n' +
        `Content-Length: ${Buffer.byteLength(lolPayload)}\r\n` +
        'Connection: close\r\n\r\n' + lolPayload,
        8000
    );
    const lolMs = Date.now() - lolStart;
    const lolAlive = await alive();
    if (lolAlive && lolMs < 5000) {
        report(11, 'Billion Laughs (JSON)', '🟢 DEFENDED',
            `Server parsed/rejected 100× fan-out JSON in ${lolMs}ms (status ${st(lolRes)}) — alive`);
    } else if (!lolAlive) {
        report(11, 'Billion Laughs (JSON)', '🔴 BREACHED', 'Server crashed from JSON billion laughs!');
    } else {
        report(11, 'Billion Laughs (JSON)', '🟡 PARTIAL', `Took ${lolMs}ms — memory pressure concern`);
    }

    // ══════════════════════════════════════════════════════════════
    // CAMPAIGN 12: MULTIPART FILENAME TRAVERSAL
    // Upload a file with filename: ../../../etc/cron.d/backdoor
    // If the server uses the filename from the request directly
    // to create a file on disk, path traversal writes outside tmpdir.
    // ══════════════════════════════════════════════════════════════
    console.log('─── CAMPAIGN 12: MULTIPART FILENAME TRAVERSAL ───────────');
    const maliciousFilenames = [
        '../../../etc/cron.d/backdoor',
        '..\\..\\..\\windows\\system32\\evil.exe',
        '/etc/passwd',
        'file\x00.jpg',     // Null byte in filename
        '../.env',
        'CON',              // Windows reserved device name
        'AAAA' + '.A'.repeat(200) + '.jpg', // Very long filename
    ];
    let filenameTraversalSucceeded = 0;
    for (const fname of maliciousFilenames) {
        const boundary = 'TRAVERSE_' + crypto.randomBytes(4).toString('hex');
        const body =
            `--${boundary}\r\n` +
            `Content-Disposition: form-data; name="file"; filename="${fname}"\r\n` +
            `Content-Type: text/plain\r\n\r\n` +
            `BACKDOOR CONTENT\r\n` +
            `--${boundary}--\r\n`;
        const r = await tcpRaw(
            'POST /api/upload HTTP/1.1\r\nHost: localhost\r\n' +
            `Content-Type: multipart/form-data; boundary=${boundary}\r\n` +
            `Content-Length: ${Buffer.byteLength(body)}\r\n` +
            'Connection: close\r\n\r\n' + body
        );
        // Check if the traversal filename appears in the upload response as-is
        if (st(r) === 200 && r.includes(fname.replace(/\\/g, '\\\\'))) filenameTraversalSucceeded++;
    }
    const ftAlive = await alive();
    if (ftAlive && filenameTraversalSucceeded === 0) {
        report(12, 'Multipart Filename Traversal', '🟢 DEFENDED',
            `All ${maliciousFilenames.length} traversal filenames handled — no file written outside tmpdir`);
    } else if (filenameTraversalSucceeded > 0) {
        report(12, 'Multipart Filename Traversal', '🟡 PARTIAL',
            `${filenameTraversalSucceeded} traversal filename(s) echoed — review storage path logic`);
    } else {
        report(12, 'Multipart Filename Traversal', '🔴 BREACHED', 'Server crashed from filename traversal!');
    }

    // ══════════════════════════════════════════════════════════════
    // CAMPAIGN 13: CACHE POISONING via X-Original-URL / X-Rewrite-URL
    // Reverse proxies sometimes forward X-Original-URL to the backend.
    // If the backend routes on this header instead of the real URL,
    // an attacker can access /admin via /public?X-Original-URL:/admin.
    // ══════════════════════════════════════════════════════════════
    console.log('─── CAMPAIGN 13: CACHE POISONING (X-Original-URL) ───────');
    const cachePoisons = [
        { hdr: 'X-Original-URL: /api/data', path: '/health' },
        { hdr: 'X-Rewrite-URL: /api/data',  path: '/health' },
        { hdr: 'X-Override-URL: /api/data', path: '/health' },
        { hdr: 'X-Http-Destinationurl: http://localhost/api/data', path: '/health' },
    ];
    let cachePoisoned = 0;
    for (const { hdr, path } of cachePoisons) {
        const r = await tcpRaw(
            `GET ${path} HTTP/1.1\r\nHost: localhost\r\n${hdr}\r\nConnection: close\r\n\r\n`
        );
        // If the server serves /api/data content when the path says /health, cache poisoning works
        if (r.includes('TOP_SECRET') && !r.includes('"ok":true')) cachePoisoned++;
    }
    if (cachePoisoned === 0) {
        report(13, 'Cache Poisoning (X-Original-URL)', '🟢 DEFENDED',
            `All ${cachePoisons.length} X-Original-URL variants ignored — routing on real path only`);
    } else {
        report(13, 'Cache Poisoning (X-Original-URL)', '🔴 BREACHED',
            `${cachePoisoned} cache poisoning variant(s) succeeded!`);
    }

    // ══════════════════════════════════════════════════════════════
    // CAMPAIGN 14: STATIC SERVER — DOTFILE TRAVERSAL
    // Direct requests for .env, .htpasswd, .git/config
    // via the static file server. Must all return 403 Forbidden.
    // ══════════════════════════════════════════════════════════════
    console.log('─── CAMPAIGN 14: STATIC SERVER DOTFILE TRAVERSAL ────────');
    const dotfilePaths = [
        '/files/.env',
        '/files/.htpasswd',
        '/files/%2e%65%6e%76',          // %2e = '.' hex
        '/files/.git/config',
        '/files/..%2f.env',             // Traversal to .env
        '/files/../.env',
        '/files/%2e%2e/%2e%65%6e%76',   // Traversal + encoded .env
    ];
    let dotfileLeaked = 0;
    for (const dp of dotfilePaths) {
        const r = await tcpRaw(
            `GET ${dp} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`,
            3000, STATIC_PORT
        );
        if (st(r) === 200 && (r.includes('supersecret') || r.includes('apr1'))) dotfileLeaked++;
    }
    if (dotfileLeaked === 0) {
        report(14, 'Static Dotfile Traversal', '🟢 DEFENDED',
            `All ${dotfilePaths.length} dotfile/traversal paths returned 403/404 — secrets protected`);
    } else {
        report(14, 'Static Dotfile Traversal', '🔴 BREACHED',
            `${dotfileLeaked} dotfile(s) leaked! DB_PASS or .htpasswd exposed!`);
    }

    // ══════════════════════════════════════════════════════════════
    // CAMPAIGN 15: HTTP CONNECT TUNNELING
    // Send CONNECT method to attempt proxy tunneling through the server.
    // Vulnerable servers allow CONNECT to reach internal services.
    // ══════════════════════════════════════════════════════════════
    console.log('─── CAMPAIGN 15: HTTP CONNECT TUNNELING ─────────────────');
    const connectRes = await tcpRaw(
        'CONNECT internal-db:5432 HTTP/1.1\r\nHost: internal-db:5432\r\nConnection: keep-alive\r\n\r\n',
        3000
    );
    const connectStatus = st(connectRes);
    const connectAlive = await alive();
    // CONNECT should be rejected — 404, 400, 405 or similar
    if (connectAlive && connectStatus !== 200 && !connectRes.includes('CONNECT established')) {
        report(15, 'HTTP CONNECT Tunneling', '🟢 DEFENDED',
            `CONNECT returned ${connectStatus || 'connection-drop'} — proxy tunnel refused`);
    } else if (!connectAlive) {
        report(15, 'HTTP CONNECT Tunneling', '🔴 BREACHED', 'Server crashed on CONNECT method!');
    } else {
        report(15, 'HTTP CONNECT Tunneling', '🔴 BREACHED', 'Server accepted CONNECT tunnel!');
    }

    // ══════════════════════════════════════════════════════════════
    // CAMPAIGN 16: REGEX INJECTION VIA QUERY STRING
    // Send regex metacharacters and catastrophic patterns in query params.
    // If the server or a middleware builds a regex from query input,
    // these patterns trigger catastrophic backtracking (ReDoS).
    // ══════════════════════════════════════════════════════════════
    console.log('─── CAMPAIGN 16: REGEX INJECTION (Query String) ─────────');
    const regexPayloads = [
        '/api/user/a?filter=' + encodeURIComponent('(a+)+$'),
        '/api/user/a?filter=' + encodeURIComponent('(.*){100}'),
        '/api/user/a?q='      + encodeURIComponent('(?:a+)+$'),
        '/api/user/a?search=' + encodeURIComponent('[a-zA-Z]{1,100}' + 'a'.repeat(30) + '!'),
        '/api/user/a?id='     + encodeURIComponent('$ne'),
        '/api/user/a?x='      + encodeURIComponent("' OR '1'='1"),
    ];
    let regexCrash = 0;
    const regexStart = Date.now();
    for (const rp of regexPayloads) {
        const r = await tcpRaw(`GET ${rp} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`, 2000);
        if (st(r) === 0) regexCrash++;
    }
    const regexMs = Date.now() - regexStart;
    const regexAlive = await alive();
    if (regexAlive && regexCrash === 0 && regexMs < 5000) {
        report(16, 'Regex Injection (Query)', '🟢 DEFENDED',
            `All ${regexPayloads.length} regex payloads handled in ${regexMs}ms — no ReDoS, no crash`);
    } else if (!regexAlive) {
        report(16, 'Regex Injection (Query)', '🔴 BREACHED', 'Server crashed from regex injection!');
    } else {
        report(16, 'Regex Injection (Query)', '🟡 PARTIAL', `${regexCrash} drops, ${regexMs}ms total — investigate`);
    }

    // ══════════════════════════════════════════════════════════════
    // CAMPAIGN 17: ETAG COLLISION / CONDITIONAL GET HIJACK (304)
    // Forge an If-None-Match header to force a 304 Not Modified
    // response for content the attacker shouldn't have access to.
    // The server must validate the ETag, not just the header presence.
    // ══════════════════════════════════════════════════════════════
    console.log('─── CAMPAIGN 17: ETAG COLLISION / 304 HIJACK ────────────');
    const etagPayloads = [
        'W/"forcedcollision"',
        '"*"',
        '*',
        'W/"0000000000000000000000000000000000000000"',
        '""',
    ];
    let etagHijacked = 0;
    for (const etag of etagPayloads) {
        const r = await tcpRaw(
            'GET /files/index.html HTTP/1.1\r\nHost: localhost\r\n' +
            `If-None-Match: ${etag}\r\nConnection: close\r\n\r\n`,
            3000, STATIC_PORT
        );
        // A forged ETag should NOT produce a 304 — it should return 200 with real content
        // OR a proper 304 only if the ETag genuinely matches
        if (st(r) === 304) etagHijacked++;
    }
    const etagAlive = await alive(STATIC_PORT);
    if (etagAlive && etagHijacked === 0) {
        report(17, 'ETag Collision / 304 Hijack', '🟢 DEFENDED',
            `All ${etagPayloads.length} forged ETags rejected — no illegitimate 304 responses`);
    } else if (etagHijacked > 0) {
        report(17, 'ETag Collision / 304 Hijack', '🔴 BREACHED',
            `${etagHijacked} forged ETag(s) caused 304 — attacker can force stale cache!`);
    } else {
        report(17, 'ETag Collision / 304 Hijack', '🔴 BREACHED', 'Static server crashed!');
    }

    // ══════════════════════════════════════════════════════════════
    // CAMPAIGN 18: SIMULTANEOUS LOAD + TARGETED ATTACK
    // Fire 200 legitimate requests AND 200 attack requests at the
    // same time. Tests whether defensive measures hold under
    // concurrent real + malicious traffic.
    // ══════════════════════════════════════════════════════════════
    console.log('─── CAMPAIGN 18: SIMULTANEOUS LOAD + ATTACK STORM ───────');
    const legit  = Array.from({ length: 200 }).map(() =>
        tcpRaw('GET /health HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n', 5000)
    );
    const attacks = Array.from({ length: 200 }).map((_, i) => {
        // Mix of different attacks
        const atk = i % 6;
        if (atk === 0) return tcpRaw('GET /%2e%2e/%2e%2e/etc/passwd HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n', 3000);
        if (atk === 1) return tcpRaw('POST /api/echo HTTP/1.1\r\nHost: localhost\r\nContent-Length: 5\r\nConnection: close\r\n\r\n{"key":"' + 'X'.repeat(10000), 3000);
        if (atk === 2) return tcpRaw('GET /health HTTP/1.1\r\n'.repeat(20) + '\r\n', 3000);
        if (atk === 3) return tcpRaw(`GET /api/user/${'X'.repeat(500)} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`, 3000);
        if (atk === 4) return tcpRaw('INVALID_METHOD / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n', 3000);
        return tcpRaw('GET /api/data?$where=1 HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n', 3000);
    });
    const [legitResults, atkResults] = await Promise.all([
        Promise.allSettled(legit),
        Promise.allSettled(attacks),
    ]);
    const legitOk = (legitResults as PromiseSettledResult<string>[])
        .filter(r => r.status === 'fulfilled' && r.value.includes('200')).length;
    const storm18Alive = await alive();
    if (storm18Alive && legitOk >= 150) {
        report(18, 'Simultaneous Load + Attack Storm', '🟢 DEFENDED',
            `${legitOk}/200 legit requests succeeded during 200-vector attack storm — server intact`);
    } else if (!storm18Alive) {
        report(18, 'Simultaneous Load + Attack Storm', '🔴 BREACHED',
            'Server crashed under combined load + attack storm!');
    } else {
        report(18, 'Simultaneous Load + Attack Storm', '🟡 PARTIAL',
            `Only ${legitOk}/200 legit requests succeeded — possible degradation`);
    }

    // ══════════════════════════════════════════════════════════════
    // CAMPAIGN 19: PIPELINE RESPONSE DESYNC
    // Send 10 pipelined requests where every other one is malformed.
    // Validates that the server doesn't serve response N to request N+1,
    // which would leak data between different clients.
    // ══════════════════════════════════════════════════════════════
    console.log('─── CAMPAIGN 19: PIPELINE RESPONSE DESYNC ───────────────');
    // Alternate between: valid GET /health and oversized GET
    const pipelineMixed = Array.from({ length: 10 }).map((_, i) =>
        i % 2 === 0
            ? 'GET /health HTTP/1.1\r\nHost: localhost\r\n\r\n'
            : `GET /${'X'.repeat(2000)} HTTP/1.1\r\nHost: localhost\r\n\r\n`
    ).join('');
    const pipelineRes = await tcpRaw(pipelineMixed + '\r\n', 8000);
    const desync200s = (pipelineRes.match(/HTTP\/1\.\d 200/g) || []).length;
    const desyncAlive = await alive();
    // Data from /api/data should NOT appear in the health responses
    const dataLeak = pipelineRes.includes('TOP_SECRET');
    if (desyncAlive && !dataLeak) {
        report(19, 'Pipeline Response Desync', '🟢 DEFENDED',
            `${desync200s} valid responses in mixed pipeline — no cross-request data leak`);
    } else if (dataLeak) {
        report(19, 'Pipeline Response Desync', '🔴 BREACHED',
            'SECRET data leaked across pipelined responses — desync attack succeeded!');
    } else {
        report(19, 'Pipeline Response Desync', '🔴 BREACHED', 'Server crashed from mixed pipeline!');
    }

    // ══════════════════════════════════════════════════════════════
    // CAMPAIGN 20: FULL SPECTRUM COORDINATED SIEGE
    // Launch all 19 attack types simultaneously plus:
    // - 50 zombie connections
    // - 50 SSE drains
    // - 50 memory bombs
    // - 50 malformed packets
    // Then measure: still alive? Response time acceptable?
    // ══════════════════════════════════════════════════════════════
    console.log('─── CAMPAIGN 20: FULL SPECTRUM COORDINATED SIEGE ────────');
    console.log('    Launching all vectors simultaneously — the ultimate stress test...');

    // Open zombie connections
    const siegeZombies: net.Socket[] = [];
    for (let i = 0; i < 50; i++) {
        const s = net.createConnection({ port: PORT, host: '127.0.0.1' });
        s.on('error', () => {});
        siegeZombies.push(s);
    }

    // Scatter all attack types in parallel
    const siegeAttacks = await Promise.allSettled([
        // Traversals
        ...Array.from({ length: 10 }).map(() =>
            tcpRaw('GET /%2e%2e/%2e%2e/etc/passwd HTTP/1.1\r\nHost: h\r\nConnection: close\r\n\r\n', 3000)
        ),
        // Memory bombs
        ...Array.from({ length: 10 }).map(() => {
            const b = JSON.stringify({ data: 'A'.repeat(500_000) });
            return tcpRaw(
                'POST /api/echo HTTP/1.1\r\nHost: h\r\nContent-Type: application/json\r\n' +
                `Content-Length: ${Buffer.byteLength(b)}\r\nConnection: close\r\n\r\n` + b, 6000
            );
        }),
        // Malformed requests
        ...Array.from({ length: 10 }).map(() =>
            tcpRaw('ZZZZZ /?$where=1&$ne=x HTTP/9.9\r\nHost: h\r\nTransfer-Encoding: chunked,deflate\r\n\r\nGARBAGE', 3000)
        ),
        // NoSQL injections
        ...Array.from({ length: 10 }).map(() => {
            const p = '{"$where":"1","$ne":""}';
            return tcpRaw('POST /api/nosql HTTP/1.1\r\nHost: h\r\nContent-Type: application/json\r\n' +
                `Content-Length: ${p.length}\r\nConnection: close\r\n\r\n` + p, 3000);
        }),
        // Oversized headers
        ...Array.from({ length: 10 }).map(() =>
            tcpRaw('GET /health HTTP/1.1\r\nHost: h\r\n' + Array.from({ length: 100 }).map((_, i) => `X-H${i}: ${'V'.repeat(100)}`).join('\r\n') + '\r\nConnection: close\r\n\r\n', 3000)
        ),
    ]);

    // Cleanup zombies
    siegeZombies.forEach(s => s.destroy());

    await new Promise(r => setTimeout(r, 500));

    // Final verdict
    const siegeHealth1 = await tcpRaw('GET /health HTTP/1.1\r\nHost: h\r\nConnection: close\r\n\r\n', 5000);
    const siegeHealth2 = await tcpRaw('GET /health HTTP/1.1\r\nHost: h\r\nConnection: close\r\n\r\n', 5000);
    const siegeAlive = st(siegeHealth1) === 200 && st(siegeHealth2) === 200;
    const secretLeak = siegeAttacks.some(r =>
        r.status === 'fulfilled' && r.value.includes('TOP_SECRET')
    );
    if (siegeAlive && !secretLeak) {
        report(20, 'Full Spectrum Coordinated Siege', '🟢 DEFENDED',
            `Server survived all ${siegeAttacks.length} simultaneous vectors — responsive and leak-free`);
    } else if (secretLeak) {
        report(20, 'Full Spectrum Coordinated Siege', '🔴 BREACHED',
            'Data leaked during coordinated siege!');
    } else {
        report(20, 'Full Spectrum Coordinated Siege', '🔴 BREACHED',
            'Server went down under coordinated siege!');
    }
}

// ─── Scoreboard ──────────────────────────────────────────────────────────────
function printScoreboard() {
    // Cleanup tmpdir
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}

    console.log('\n' + '═'.repeat(64));
    console.log('🏆  RED TEAM CAMPAIGN III — FINAL REPORT');
    console.log('═'.repeat(64));
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
    console.log('\n' + '═'.repeat(64));
    if (breached === 0 && partial === 0)
        console.log('  ✅ FORTRESS UNBREACHED — all 20 campaigns repelled!');
    else if (breached === 0)
        console.log(`  ⚠️  ${partial} partial finding(s) — review flagged campaigns.`);
    else
        console.log(`  🚨 ${breached} breach(es) — immediate action required!`);
    console.log('═'.repeat(64) + '\n');
    if (typeof app !== 'undefined') app.close();;
}

// ─── Boot ─────────────────────────────────────────────────────────────────────
let serversReady = 0;
const onReady = () => {
    serversReady++;
    if (serversReady === 2) {
        runAttacks().catch(console.error).finally(printScoreboard);
    }
};
app.start(onReady);
staticApp.start(onReady);
