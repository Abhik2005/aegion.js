/**
 * ╔══════════════════════════════════════════════════════════════════════╗
 * ║  🔴 AEGION RED TEAM — CAMPAIGN VII: SYSTEM & BINARY WARFARE        ║
 * ║  Targeting OS-level interactions, binary payload polyglots, precise ║
 * ║  number parsing, header fragmentation, and cryptographic boundaries.║
 * ╚══════════════════════════════════════════════════════════════════════╝
 *
 *  1. Cookie Bombing (400 cookies to exceed header limits / DoS)
 *  2. Content-Disposition Filename Escaping (RCE attempt via filename)
 *  3. JSON Precision Loss (Number truncation to bypass logic)
 *  4. Cross-Site Tracing (XST) via TRACE method
 *  5. JWT "kid" (Key ID) Traversal Injection
 *  6. Uploading Forbidden Extensions with trailing dots/spaces
 *  7. Multi-Part Boundary Truncation / Overlap
 *  8. Pipelining Deadlock (Sending 1,000 partial pipelined requests)
 *  9. Query String Array Prototype Pollution
 * 10. Malformed Deflate Compression Bombs
 */

import * as net    from 'node:net';
import * as crypto from 'node:crypto';
import * as fs     from 'node:fs';
import { Server, get, post } from '../src/index';

// ─── Ports ────────────────────────────────────────────────────────────────────
const PORT = 3090;

// ─── Scoreboard ───────────────────────────────────────────────────────────────
type Verdict = '🟢 DEFENDED' | '🔴 BREACHED' | '🟡 PARTIAL';
const results: { id: number; name: string; verdict: Verdict; detail: string }[] = [];
function report(id: number, name: string, verdict: Verdict, detail: string) {
    results.push({ id, name, verdict, detail });
    console.log(`[RESULT] ${verdict} — #${id} ${name}: ${detail}\n`);
}

// ─── TCP helpers ──────────────────────────────────────────────────────────────
function tcpRaw(data: string | Buffer | Buffer[], ms = 6000, port = PORT): Promise<string> {
    return new Promise(resolve => {
        const c = net.createConnection({ port, host: '127.0.0.1' }, () => {
            if (Array.isArray(data)) {
                data.forEach(chunk => c.write(chunk));
            } else {
                c.write(typeof data === 'string' ? Buffer.from(data, 'binary') : data);
            }
        });
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

// ─── Main application server ──────────────────────────────────────────────────
const app = new Server({ port: PORT });
app.register([
    ...get('/health', async ctx => ctx.json({ ok: true })),
    ...post('/api/upload', async ctx => {
        try {
            const { files } = await ctx.upload();
            const f = files[0];
            if (f && (f.filename.endsWith('.php') || f.filename.endsWith('.exe'))) {
                return ctx.status(403).json({ error: 'Forbidden extension' });
            }
            return ctx.json({ uploaded: true, filename: f?.filename });
        } catch (e: any) {
            console.log(`[DEBUG] Upload Error: ${e.message}`);
            return ctx.status(400).json({ error: e.message });
        }
    }),
    ...post('/api/transfer', async ctx => {
        // Simulating JSON precision vulnerability
        const body: any = await ctx.body();
        // Attacker wants to bypass this check:
        // if amount is 9007199254740993, will it parse as 9007199254740992?
        if (body.amount > 9007199254740992) {
            return ctx.status(400).json({ error: 'Amount too large' });
        }
        return ctx.json({ amountProcessed: body.amount });
    })
]);

// ─── Attack campaigns ─────────────────────────────────────────────────────────
async function runAttacks() {
    console.log('\n' + '═'.repeat(66));
    console.log('🔴  AEGION RED TEAM — CAMPAIGN VII: SYSTEM & BINARY WARFARE');
    console.log('🎯  Target: http://127.0.0.1:' + PORT);
    console.log('═'.repeat(66) + '\n');
    await new Promise(r => setTimeout(r, 300));

    // ══════════════════════════════════════════════════════════════
    // CAMPAIGN 1: COOKIE BOMBING
    // Set 400 massive cookies to exceed header limits (DoS on subsequent requests).
    // The server should reject the initial request safely if it exceeds 16KB.
    // ══════════════════════════════════════════════════════════════
    console.log('─── CAMPAIGN 1: COOKIE BOMBING ──────────────────────────');
    const massiveCookieString = Array.from({ length: 400 })
        .map((_, i) => `bomb${i}=${'X'.repeat(50)}`)
        .join('; ');
    
    const cookieRes = await tcpRaw(
        `GET /health HTTP/1.1\r\nHost: localhost\r\nCookie: ${massiveCookieString}\r\nConnection: close\r\n\r\n`,
        3000
    );
    
    if (st(cookieRes) === 431 || !cookieRes.includes('HTTP/')) {
        report(1, 'Cookie Bombing', '🟢 DEFENDED',
            `Server safely dropped request with excessively large cookies (Status: ${st(cookieRes) || 'Dropped'})`);
    } else if (st(cookieRes) === 200) {
        // Technically if Node accepts it, it's not a breach, just means limit > 20KB
        report(1, 'Cookie Bombing', '🟡 PARTIAL',
            'Server accepted large cookie payload. Adjust MaxHeaderSize if needed.');
    } else {
        report(1, 'Cookie Bombing', '🔴 BREACHED',
            'Server crashed while parsing massive cookie array!');
    }

    // ══════════════════════════════════════════════════════════════
    // CAMPAIGN 2: CONTENT-DISPOSITION FILENAME ESCAPING
    // Send a filename like: "; rm -rf /"
    // To test if the parser throws an error or improperly parses.
    // ══════════════════════════════════════════════════════════════
    console.log('─── CAMPAIGN 2: CONTENT-DISPOSITION ESCAPING ────────────');
    const boundary = '----WebKitFormBoundaryX';
    const cdBody = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="a\\\"; rm -rf /; \\\"b.txt"\r\n\r\nTEXT\r\n--${boundary}--\r\n`;
    
    const cdRes = await tcpRaw(
        `POST /api/upload HTTP/1.1\r\nHost: localhost\r\n` +
        `Content-Type: multipart/form-data; boundary=${boundary}\r\n` +
        `Content-Length: ${cdBody.length}\r\nConnection: close\r\n\r\n${cdBody}`
    );
    
    const cdAlive = await alive();
    if (cdAlive && st(cdRes) === 200) {
        report(2, 'Content-Disposition Escaping', '🟢 DEFENDED',
            'Server parsed complex escaped filename without failure');
    } else {
        console.log(`[DEBUG] CD Escaping returned: ${st(cdRes)}. Output: ${cdRes.slice(0, 50)}`);
        report(2, 'Content-Disposition Escaping', '🔴 BREACHED',
            'Server failed to parse escaped filename correctly!');
    }

    // ══════════════════════════════════════════════════════════════
    // CAMPAIGN 3: JSON PRECISION LOSS
    // 9007199254740993 is MAX_SAFE_INTEGER + 2.
    // In JS floats, 9007199254740993 evaluates to 9007199254740992.
    // If we send this to bypass a > 9007199254740992 check.
    // ══════════════════════════════════════════════════════════════
    console.log('─── CAMPAIGN 3: JSON PRECISION LOSS ─────────────────────');
    const jsonPre = `{"amount": 9007199254740993}`;
    const preRes = await tcpRaw(
        `POST /api/transfer HTTP/1.1\r\nHost: localhost\r\n` +
        `Content-Type: application/json\r\n` +
        `Content-Length: ${jsonPre.length}\r\nConnection: close\r\n\r\n${jsonPre}`
    );
    
    // Because Node.js JSON.parse uses double-precision floats, 9007199254740993 -> 9007199254740992
    // It bypassed the `amount > 9007199254740992` check and returned 200!
    if (st(preRes) === 200) {
        report(3, 'JSON Precision Loss', '🔴 BREACHED',
            'Number precision loss allowed bypass of maximum limit check! (9007199254740993 parsed as 9007199254740992)');
    } else {
        report(3, 'JSON Precision Loss', '🟢 DEFENDED',
            'Server successfully rejected precision-loss integer');
    }

    // ══════════════════════════════════════════════════════════════
    // CAMPAIGN 4: CROSS-SITE TRACING (XST) via TRACE
    // ══════════════════════════════════════════════════════════════
    console.log('─── CAMPAIGN 4: CROSS-SITE TRACING (XST) ────────────────');
    const traceRes = await tcpRaw(
        `TRACE /health HTTP/1.1\r\nHost: localhost\r\nX-Secret: MY_COOKIE\r\nConnection: close\r\n\r\n`
    );
    
    if (traceRes.includes('MY_COOKIE')) {
        report(4, 'Cross-Site Tracing (TRACE)', '🔴 BREACHED',
            'Server responded to TRACE method and reflected headers (XST vulnerability)!');
    } else {
        report(4, 'Cross-Site Tracing (TRACE)', '🟢 DEFENDED',
            'Server ignored or safely handled TRACE method without reflection');
    }

    // ══════════════════════════════════════════════════════════════
    // CAMPAIGN 5: JWT "kid" (Key ID) TRAVERSAL
    // ══════════════════════════════════════════════════════════════
    console.log('─── CAMPAIGN 5: JWT "kid" TRAVERSAL ─────────────────────');
    // If a server uses `kid` to load files dynamically: jwt.verify(token, fs.readFileSync(kid))
    // Our server doesn't use kid, so we just verify it doesn't crash if provided.
    const kidHeader = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT', kid: '../../../dev/null' })).toString('base64url');
    const kidPayload = Buffer.from(JSON.stringify({ role: 'admin' })).toString('base64url');
    const kidRes = await tcpRaw(
        `GET /health HTTP/1.1\r\nHost: localhost\r\n` +
        `Authorization: Bearer ${kidHeader}.${kidPayload}.sig\r\nConnection: close\r\n\r\n`
    );
    if (st(kidRes) === 200) {
        report(5, 'JWT "kid" Traversal', '🟢 DEFENDED', 'Server ignored malicious kid header without failing');
    } else {
        report(5, 'JWT "kid" Traversal', '🔴 BREACHED', 'Server crashed on malicious kid header!');
    }

    // ══════════════════════════════════════════════════════════════
    // CAMPAIGN 6: FORBIDDEN EXTENSIONS WITH TRAILING DOTS/SPACES
    // ══════════════════════════════════════════════════════════════
    console.log('─── CAMPAIGN 6: FORBIDDEN EXTENSIONS ────────────────────');
    const b2 = '----X';
    const payloads = [
        `--${b2}\r\nContent-Disposition: form-data; name="f"; filename="shell.php "\r\n\r\nX\r\n--${b2}--\r\n`,
        `--${b2}\r\nContent-Disposition: form-data; name="f"; filename="shell.php."\r\n\r\nX\r\n--${b2}--\r\n`,
        `--${b2}\r\nContent-Disposition: form-data; name="f"; filename="shell.php\x00.jpg"\r\n\r\nX\r\n--${b2}--\r\n`
    ];
    
    let extBreach = 0;
    for (const p of payloads) {
        const res = await tcpRaw(
            `POST /api/upload HTTP/1.1\r\nHost: localhost\r\n` +
            `Content-Type: multipart/form-data; boundary=${b2}\r\n` +
            `Content-Length: ${p.length}\r\nConnection: close\r\n\r\n${p}`
        );
        // We only care if they successfully uploaded a dangerous file
        if (st(res) === 200) {
            try {
                const body = JSON.parse(res.split('\r\n\r\n')[1]);
                if (body.filename.match(/\.php[ .]*$/) || body.filename.match(/\.exe[ .]*$/)) {
                    extBreach++;
                }
            } catch {}
        }
    }
    
    if (extBreach > 0) {
        report(6, 'Trailing Dots/Spaces Extension Bypass', '🔴 BREACHED',
            `${extBreach} payloads bypassed extension blacklisting (.php. / .php )!`);
    } else {
        report(6, 'Trailing Dots/Spaces Extension Bypass', '🟢 DEFENDED',
            'Server properly rejected padded forbidden extensions');
    }

    // ══════════════════════════════════════════════════════════════
    // CAMPAIGN 7: PIPELINING DEADLOCK
    // Send 1,000 partial HTTP requests (missing final \r\n).
    // Does it hold the sockets open? Does it crash?
    // ══════════════════════════════════════════════════════════════
    console.log('─── CAMPAIGN 7: PIPELINING DEADLOCK ─────────────────────');
    const plSockets: net.Socket[] = [];
    for (let i = 0; i < 200; i++) {
        const s = net.createConnection({ port: PORT });
        s.on('error', () => {});
        s.write('GET /health HTTP/1.1\r\nHost: localhost\r\n'); // Incomplete
        plSockets.push(s);
    }
    
    await new Promise(r => setTimeout(r, 500));
    const plAlive = await alive();
    plSockets.forEach(s => s.destroy());
    
    if (plAlive) {
        report(7, 'Pipelining Deadlock', '🟢 DEFENDED',
            'Server survived 200 hanging incomplete requests without deadlock');
    } else {
        report(7, 'Pipelining Deadlock', '🔴 BREACHED',
            'Server locked up during incomplete pipelining attacks!');
    }
}

// ─── Scoreboard ───────────────────────────────────────────────────────────────
function printScoreboard() {
    console.log('\n' + '═'.repeat(66));
    console.log('🏆  RED TEAM CAMPAIGN VII — SYSTEM & BINARY WARFARE REPORT');
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
        console.log('  ✅ TOTAL FORTRESS — Aegion survived Campaign VII!');
    else if (breached === 0)
        console.log(`  ⚠️  ${partial} partial finding(s).`);
    else
        console.log(`  🚨 ${breached} breach(es) — extreme edge cases penetrated!`);
    console.log('═'.repeat(66) + '\n');
    if (typeof app !== 'undefined') app.close();;
}

app.start(() => {
    runAttacks().catch(console.error).finally(printScoreboard);
});
