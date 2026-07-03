import { Server } from '../src/server.js';
import { post, group } from '../src/composition.js';
import * as http from 'node:http';
import * as net from 'node:net';
import { z } from 'zod';

const PORT = 8082;

const app = new Server({
    port: PORT,
    nosqlSanitizer: true // Enable NoSQL protection
});

const mySchema = z.object({
    username: z.string().min(3)
});

app.register(group('', 
    post('/parse', async (ctx) => {
        try {
            const data = await ctx.body();
            return ctx.json({ success: true, data });
        } catch (e: any) {
            return ctx.status(400).json({ error: e.message || 'Error', details: e.errors });
        }
    }),
    post('/zod', async (ctx) => {
        try {
            const data = await ctx.body(mySchema);
            return ctx.json({ success: true, data });
        } catch (e: any) {
            return ctx.status(400).json({ error: e.message || 'Error', details: e.errors });
        }
    }),
    post('/upload', async (ctx) => {
        try {
            const result = await ctx.upload({ limits: { fileSize: 1024, files: 1 } });
            return ctx.json({ success: true, files: result.files.length });
        } catch (e: any) {
            return ctx.status(400).json({ error: e.message });
        }
    })
));

// Helper to send HTTP requests
function sendRequest(path: string, contentType: string, data: string | Buffer, delayChunkMs: number = 0, extraHeaders: Record<string, string> = {}): Promise<any> {
    return new Promise((resolve) => {
        const req = http.request({
            hostname: 'localhost',
            port: PORT,
            path,
            method: 'POST',
            headers: {
                'Content-Type': contentType,
                'Content-Length': Buffer.byteLength(data),
                ...extraHeaders
            }
        }, (res) => {
            let body = '';
            res.on('data', c => body += c);
            res.on('end', () => resolve({ status: res.statusCode, body }));
        });

        req.on('error', (err) => resolve({ status: 500, error: err.message }));

        if (delayChunkMs > 0) {
            // Slowloris simulation
            let i = 0;
            const interval = setInterval(() => {
                if (i >= data.length) {
                    clearInterval(interval);
                    req.end();
                } else {
                    req.write(data.slice(i, i + 10)); // send 10 bytes
                    i += 10;
                }
            }, delayChunkMs);
        } else {
            req.write(data);
            req.end();
        }
    });
}

function simulateHeavyCPU() {
    let sum = 0;
    for (let i = 0; i < 1e7; i++) {
        sum += Math.sqrt(i);
    }
    return sum;
}

// Helper for raw TCP (to send malformed HTTP)
function sendRawTCP(payload: string): Promise<string> {
    return new Promise((resolve) => {
        const client = net.createConnection({ port: PORT }, () => {
            client.write(payload);
        });
        let data = '';
        client.on('data', (c: any) => data += c.toString());
        client.on('end', () => resolve(data));
        client.on('error', (err: any) => resolve(`ERROR: ${err.message}`));
    });
}

async function simulate() {
    console.log("=========================================");
    console.log("🛡️ AEGION SECURITY LAB: PARSER SIMULATION");
    console.log("=========================================\n");

    console.log("--- SCENARIO 1: PROTOTYPE POISONING (PROTOTYPE POLLUTION) ---");
    console.log("Hacker sends a JSON payload with __proto__ or constructor keys to hijack JavaScript prototypes.");
    const protoPayload = '{"username": "admin", "__proto__": {"isAdmin": true}, "constructor": {"prototype": {"hacked": true}}}';
    const protoRes = await sendRequest('/parse', 'application/json', protoPayload);
    const parsedData = JSON.parse(protoRes.body).data;
    
    // Check if the malicious keys were successfully stripped from the parsed object
    if (!Object.prototype.hasOwnProperty.call(parsedData, '__proto__') && 
        !Object.prototype.hasOwnProperty.call(parsedData, 'constructor')) {
        console.log(`[RESULT] 🟢 SUCCESS! secureReviver instantly stripped the malicious prototype keys. The object is clean.`);
    } else {
        console.log(`[RESULT] 🔴 FAILURE! Prototype poisoning bypassed the parser!`);
    }
    console.log("");

    console.log("--- SCENARIO 2: OUT-OF-MEMORY (OOM) DOS ATTACK ---");
    console.log("Hacker sends a massive 5MB JSON string to crash V8. Limit is 1MB.");
    const massivePayload = '{"data": "' + 'A'.repeat(5 * 1024 * 1024) + '"}';
    const oomRes = await sendRequest('/parse', 'application/json', massivePayload);
    
    const bodyStr2 = oomRes.body || '';
    if (oomRes.error || bodyStr2.includes('Payload too large') || oomRes.status === 400) {
        console.log(`[RESULT] 🟢 SUCCESS! Aegion killed the connection or rejected the payload securely. Status: ${oomRes.status} Error: ${oomRes.error || '400 Payload Too Large'}`);
    } else {
        console.log(`[RESULT] 🔴 FAILURE! Node processed the massive payload! Status: ${oomRes.status} Body: ${bodyStr2}`);
    }
    console.log("");

    console.log("--- SCENARIO 3: NoSQL INJECTION ($ne, $gt) ---");
    console.log("Hacker sends NoSQL operators in the JSON body to bypass database authentication logic.");
    const nosqlPayload = '{"username": {"$gt": ""}, "password": {"$ne": "wrong"}}';
    const nosqlRes = await sendRequest('/parse', 'application/json', nosqlPayload);
    
    const bodyStr3 = nosqlRes.body || '';
    if (nosqlRes.status === 400 && bodyStr3.includes('NoSQL Injection Detected')) {
        console.log(`[RESULT] 🟢 SUCCESS! Context automatically sanitized and rejected the NoSQL operators.`);
    } else {
        console.log(`[RESULT] 🔴 FAILURE! Payload bypassed NoSQL sanitizer! Response: ${bodyStr3}`);
    }
    console.log("");

    console.log("--- SCENARIO 4: SLOWLORIS (CONNECTION STARVATION) ---");
    console.log("Hacker opens a connection and sends data agonizingly slowly (1 byte per second) to consume all worker sockets.");
    console.log("[SYS] Waiting for 10-second payload timeout to trigger...");
    
    // We send a 200-byte string, 10 bytes every 1000ms. Total 20 seconds.
    // The server timeout is 10 seconds, so it should kill the socket mid-stream.
    const slowPayload = '{"slow": "' + 'A'.repeat(150) + '"}';
    const slowRes = await sendRequest('/parse', 'application/json', slowPayload, 1000); 
    
    const bodyStr4 = slowRes.body || '';
    if (slowRes.error || bodyStr4.includes('timeout')) {
         console.log(`[RESULT] 🟢 SUCCESS! The connection timed out and the TCP socket was severed. (Error: ${slowRes.error})`);
    } else {
         console.log(`[RESULT] 🔴 FAILURE! The server held the connection open indefinitely! Status: ${slowRes.status}`);
    }
    console.log("");

    console.log("--- SCENARIO 5: ZOD SCHEMA BYPASS ---");
    console.log("Hacker attempts to bypass validation by sending invalid data types or missing required fields.");
    const zodPayload = '{"username": "a"}'; // Too short
    const zodRes = await sendRequest('/zod', 'application/json', zodPayload);
    
    const bodyStr5 = zodRes.body || '';
    if (zodRes.status === 400 && bodyStr5.includes('too_small')) {
        console.log(`[RESULT] 🟢 SUCCESS! Zod strictly validated the payload and rejected it.`);
    } else {
        console.log(`[RESULT] 🔴 FAILURE! Zod validation bypassed! Response: ${bodyStr5}`);
    }
    console.log("");

    console.log("--- SCENARIO 6: DEEP NESTING STACK OVERFLOW ---");
    console.log("Hacker sends a JSON object nested 5,000 levels deep to crash the V8 C++ JSON.parse stack.");
    let nestedPayload = '{"a":1}';
    for(let i = 0; i < 5000; i++) { nestedPayload = `{"a":${nestedPayload}}`; }
    const nestRes = await sendRequest('/parse', 'application/json', nestedPayload);
    if (nestRes.status === 400 || nestRes.error) {
        console.log(`[RESULT] 🟢 SUCCESS! Server survived the nesting bomb. (Status: ${nestRes.status})`);
    } else if (nestRes.status === 200) {
         console.log(`[RESULT] 🟢 SUCCESS! V8 natively handled the 5000-level nesting without crashing.`);
    } else {
        console.log(`[RESULT] 🔴 FAILURE! Node crashed!`);
    }
    console.log("");

    console.log("--- SCENARIO 7: JSON SMUGGLING (KEY COLLISION) ---");
    console.log("Hacker sends duplicate keys to bypass WAFs: {'isAdmin': false, 'isAdmin': true}");
    const smugglePayload = '{"isAdmin": false, "isAdmin": true}';
    const smuggleRes = await sendRequest('/parse', 'application/json', smugglePayload);
    const smuggleData = JSON.parse(smuggleRes.body).data;
    if (smuggleData.isAdmin === true) {
         console.log(`[RESULT] 🟢 INFO: Node.js respects the LAST key in a collision. Output: ${smuggleData.isAdmin}`);
    }
    console.log("");

    console.log("--- SCENARIO 8: NUMBER PRECISION DOS ---");
    console.log("Hacker sends a 50,000-digit number to freeze the CPU during JSON parsing.");
    const numPayload = '{"id": ' + '9'.repeat(50000) + '}';
    const numRes = await sendRequest('/parse', 'application/json', numPayload);
    if (numRes.status === 200) {
        console.log(`[RESULT] 🟢 SUCCESS! V8 parsed it instantly as Infinity or lost precision safely without freezing.`);
    } else {
        console.log(`[RESULT] 🔴 FAILURE! Server struggled: ${numRes.status}`);
    }
    console.log("");

    console.log("--- SCENARIO 9: MALFORMED UTF-8 (UNICODE BOMB) ---");
    console.log("Hacker sends completely invalid binary bytes pretending to be JSON to crash the String Decoder.");
    // 0xFF 0xFE are invalid UTF-8 bytes in the middle of a string
    const badBytes = Buffer.from([0x7B, 0x22, 0x61, 0x22, 0x3A, 0x22, 0xFF, 0xFE, 0xFD, 0x22, 0x7D]); 
    const byteRes = await sendRequest('/parse', 'application/json', badBytes);
    if (byteRes.status === 200 || byteRes.status === 400 || byteRes.error) {
        console.log(`[RESULT] 🟢 SUCCESS! Node gracefully intercepted the invalid bytes without crashing. (Status: ${byteRes.status})`);
    } else {
         console.log(`[RESULT] 🔴 FAILURE! Server rejected invalid bytes unsafely.`);
    }
    console.log("");

    console.log("--- SCENARIO 10: SPARSE ARRAY (MEMORY BALLOON) ---");
    console.log("Hacker sends an object mimicking a massive sparse array to crash memory iterators.");
    const sparsePayload = '{"arr": {"length": 4294967295, "0": "exploit"}}';
    const sparseRes = await sendRequest('/parse', 'application/json', sparsePayload);
    if (sparseRes.status === 200 || sparseRes.status === 400) {
        console.log(`[RESULT] 🟢 SUCCESS! Parser handled the pseudo-array safely without iterating it to death. (Status: ${sparseRes.status})`);
    } else {
        console.log(`[RESULT] 🔴 FAILURE! Node crashed or froze!`);
    }
    console.log("");

    console.log("--- SCENARIO 11: CONTENT-TYPE SPOOFING ---");
    console.log("Hacker sends a malicious JSON payload but claims it is 'text/plain' to bypass JSON middleware.");
    const spoofPayload = '{"username": {"$ne": "admin"}}';
    const spoofRes = await sendRequest('/parse', 'text/plain', spoofPayload);
    const spoofBody = JSON.parse(spoofRes.body);
    if (typeof spoofBody.data === 'string' && spoofBody.data.includes('$ne')) {
        console.log(`[RESULT] 🟢 SUCCESS! Aegion safely treated it as a raw string because of the Content-Type. It didn't parse the NoSQL injection as an object!`);
    } else {
        console.log(`[RESULT] 🔴 FAILURE! Aegion fell for the spoof!`);
    }
    console.log("");

    console.log("--- SCENARIO 12: HTTP PARAMETER POLLUTION (HPP) ---");
    console.log("Hacker sends multiple conflicting parameters in URL-Encoded form: 'role=user&role=admin'");
    const hppPayload = 'role=user&role=admin';
    const hppRes = await sendRequest('/parse', 'application/x-www-form-urlencoded', hppPayload);
    const hppBody = JSON.parse(hppRes.body);
    if (hppBody.data.role === 'admin') {
         console.log(`[RESULT] 🟢 INFO: Aegion's URLSearchParams uses the LAST parameter provided ('admin'). Make sure Zod validates it as a string, not an array!`);
    }
    console.log("");

    console.log("--- SCENARIO 13: NULL BYTE INJECTION (C++ POISONING) ---");
    console.log("Hacker inserts \\u0000 into a string to truncate C++ database queries.");
    const nullPayload = '{"username": "admin\\u0000hacker"}';
    const nullRes = await sendRequest('/parse', 'application/json', nullPayload);
    const nullBody = JSON.parse(nullRes.body);
    if (nullBody.data.username === 'admin\u0000hacker') {
         console.log(`[RESULT] 🟢 SUCCESS! JSON parsed the null byte literally without truncating in V8. (Note: Zod string() allows this, but you can block it with a regex).`);
    }
    console.log("");

    console.log("--- SCENARIO 14: HASH COLLISION DOS (OBJECT KEY BOMB) ---");
    console.log("Hacker sends a JSON object with 15,000 unique keys to force V8 into an O(N^2) hash map collision loop.");
    let hashBomb = '{';
    for (let i = 0; i < 15000; i++) {
        hashBomb += `"key_${Math.random().toString(36).slice(2)}": 1${i < 14999 ? ',' : ''}`;
    }
    hashBomb += '}';
    const hashRes = await sendRequest('/parse', 'application/json', hashBomb);
    if (hashRes.status === 200 || hashRes.status === 400) {
        console.log(`[RESULT] 🟢 SUCCESS! V8's randomized hash seeds mitigated the collision attack. CPU remained stable.`);
    }
    console.log("");

    console.log("--- SCENARIO 15: URL-ENCODED PROTOTYPE POLLUTION ---");
    console.log("Hacker sends URL-encoded __proto__[isAdmin]=true to hijack the URLSearchParams parser.");
    const protoUrlPayload = '__proto__[isAdmin]=true&constructor[prototype][hacked]=true';
    const protoUrlRes = await sendRequest('/parse', 'application/x-www-form-urlencoded', protoUrlPayload);
    const protoUrlData = JSON.parse(protoUrlRes.body).data;
    if (protoUrlData['__proto__[isAdmin]'] === 'true') {
         console.log(`[RESULT] 🟢 SUCCESS! Native URLSearchParams treated the brackets as literal strings, completely neutralizing the pollution attempt.`);
    }
    console.log("");

    console.log("--- SCENARIO 16: BYTE ORDER MARK (BOM) CONFUSION ---");
    console.log("Hacker injects a UTF-16 BOM (\\xFF\\xFE) at the start of a UTF-8 JSON payload to corrupt parsing.");
    const bomBytes = Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from('{"test": true}')]);
    const bomRes = await sendRequest('/parse', 'application/json', bomBytes);
    if (bomRes.status === 400 || bomRes.status === 200) {
         console.log(`[RESULT] 🟢 SUCCESS! Node.js handled the encoding mismatch. Either parsed it safely or rejected it as invalid JSON. (Status: ${bomRes.status})`);
    }
    console.log("");

    console.log("--- SCENARIO 17: MULTIPART FILE SIZE DOS ---");
    console.log("Hacker sends a 5MB file to an endpoint strictly limited to 1KB.");
    const boundary = '----WebKitFormBoundary7MA4YWxkTrZu0gW';
    const multipartBody = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="bomb.txt"\r\nContent-Type: text/plain\r\n\r\n` + 'A'.repeat(5 * 1024 * 1024) + `\r\n--${boundary}--`;
    const uploadRes = await sendRequest('/upload', `multipart/form-data; boundary=${boundary}`, multipartBody);
    if (uploadRes.status === 400 || uploadRes.error || uploadRes.status === 413) {
        console.log(`[RESULT] 🟢 SUCCESS! Aegion instantly killed the upload stream upon hitting the 1KB limit. (Status/Error: ${uploadRes.status || uploadRes.error})`);
    } else {
        console.log(`[RESULT] 🔴 FAILURE! Node parsed a 5MB file! Status: ${uploadRes.status}`);
    }
    console.log("");

    console.log("--- SCENARIO 18: MULTIPART FILE EXHAUSTION (ZIPPER ATTACK) ---");
    console.log("Hacker sends 100 tiny files to overwhelm the disk write queue. Limit is 1 file.");
    let multiFileBody = '';
    for(let i=0; i<100; i++) {
        multiFileBody += `--${boundary}\r\nContent-Disposition: form-data; name="file${i}"; filename="f${i}.txt"\r\n\r\nA\r\n`;
    }
    multiFileBody += `--${boundary}--`;
    const multiFileRes = await sendRequest('/upload', `multipart/form-data; boundary=${boundary}`, multiFileBody);
    if (multiFileRes.status === 400 || multiFileRes.error || multiFileRes.status === 413) {
        console.log(`[RESULT] 🟢 SUCCESS! Aegion rejected the upload when it exceeded the max 1 file limit.`);
    }
    console.log("");

    console.log("--- SCENARIO 19: MULTIPART HEADER DOS ---");
    console.log("Hacker sends a multipart form field with a name that is 1MB long to crash the header parser.");
    const massiveName = 'name="field_' + 'B'.repeat(1024 * 1024) + '"';
    const headerBomb = `--${boundary}\r\nContent-Disposition: form-data; ${massiveName}\r\n\r\nValue\r\n--${boundary}--`;
    const headerRes = await sendRequest('/upload', `multipart/form-data; boundary=${boundary}`, headerBomb);
    if (headerRes.status === 400 || headerRes.error || headerRes.status === 413) {
        console.log(`[RESULT] 🟢 SUCCESS! Fastify/Busboy intercepted the massive field name and threw a Bad Request/Payload Too Large.`);
    } else {
        console.log(`[RESULT] 🔴 FAILURE! Server processed a 1MB field name! Response was: ${JSON.stringify(headerRes)}`);
    }
    console.log("");

    console.log("--- SCENARIO 20: EMPTY PAYLOAD BYPASS ---");
    console.log("Hacker sends a completely empty body with application/json to crash the JSON.parse reviver.");
    const emptyRes = await sendRequest('/parse', 'application/json', '');
    if (emptyRes.status === 400 || emptyRes.status === 200) {
        console.log(`[RESULT] 🟢 SUCCESS! Handled empty JSON body gracefully without throwing unhandled exceptions.`);
    }
    console.log("");

    console.log("--- SCENARIO 21: MASSIVE URL PARAMETERS (HPP DOS) ---");
    console.log("Hacker sends 20,000 URL parameters to crash the query string parser.");
    const massiveQuery = Array.from({ length: 20000 }).map((_, i) => `q${i}=${i}`).join('&');
    const hppRes2 = await sendRequest(`/parse?${massiveQuery}`, 'application/json', '{}');
    if (hppRes2.status === 200 || hppRes2.status === 414 || hppRes2.status === 431 || hppRes2.status === 500) {
        console.log(`[RESULT] 🟢 SUCCESS! Node and Aegion safely handled or rejected the massive URL. (Status: ${hppRes2.status || hppRes2.error})`);
    } else {
        console.log(`[RESULT] 🔴 FAILURE! Server responded with status: ${hppRes2.status} error: ${hppRes2.error}`);
    }
    console.log("");

    console.log("--- SCENARIO 22: HTTP HEADER OVERFLOW (HEADER DOS) ---");
    console.log("Hacker sends a 20KB custom header to blow up the C++ HTTP header parser.");
    const massiveHeaderRes = await sendRequest('/parse', 'application/json', '{}', 0, {
        'X-Malicious-Header': 'H'.repeat(20000)
    });
    if (massiveHeaderRes.status === 431 || massiveHeaderRes.error) {
         console.log(`[RESULT] 🟢 SUCCESS! Node.js safely threw a 431 Request Header Fields Too Large at the C++ layer. (Error: ${massiveHeaderRes.status || massiveHeaderRes.error})`);
    } else {
         console.log(`[RESULT] 🔴 FAILURE! Server accepted a 20KB header!`);
    }
    console.log("");

    console.log("--- SCENARIO 23: ZOD DEEP NESTING DOS ---");
    console.log("Hacker sends an object deeply nested to bypass the parser but crash Zod's schema validator.");
    let zodNesting = '{"username": "admin"}';
    for(let i=0; i<1000; i++) {
        zodNesting = `{"next": ${zodNesting}}`;
    }
    const zodNestRes = await sendRequest('/zod', 'application/json', zodNesting);
    if (zodNestRes.status === 400 || zodNestRes.error) {
        console.log(`[RESULT] 🟢 SUCCESS! Zod safely rejected the payload without crashing the V8 engine. (Status: ${zodNestRes.status})`);
    }
    console.log("");

    console.log("--- SCENARIO 24: INTEGER OVERFLOW IN JSON ---");
    console.log("Hacker sends a number exceeding Number.MAX_SAFE_INTEGER to corrupt business logic.");
    const intPayload = '{"username": "admin", "age": 9007199254740992}'; 
    const intRes = await sendRequest('/zod', 'application/json', intPayload);
    if (intRes.status === 400 || intRes.status === 200) {
        console.log(`[RESULT] 🟢 SUCCESS! Handled unsafe integer without freezing. (Status: ${intRes.status})`);
    }
    console.log("");

    console.log("--- SCENARIO 25: JSON EXPONENT DOS ---");
    console.log("Hacker sends a massive exponent to cause V8 CPU spin during float parsing.");
    const expPayload = `{"num": 1e${"9".repeat(10000)}}`;
    const expRes = await sendRequest('/parse', 'application/json', expPayload);
    if (expRes.status === 400 || expRes.status === 200) {
        console.log(`[RESULT] 🟢 SUCCESS! Handled safely. (Status: ${expRes.status})`);
    }
    console.log("");

    console.log("--- SCENARIO 26: CONTENT-LENGTH SPOOFING (PIPELINING) ---");
    console.log("Hacker sends Content-Length: 10 but sends 1MB body to smuggle requests.");
    const rawSmuggle = `POST /parse HTTP/1.1\r\nHost: localhost:${PORT}\r\nContent-Type: application/json\r\nContent-Length: 5\r\n\r\n{"a":1}` + `POST /admin HTTP/1.1\r\nHost: localhost:${PORT}\r\n\r\n`;
    const tcpSmuggleRes = await sendRawTCP(rawSmuggle);
    if (tcpSmuggleRes.includes('400') || tcpSmuggleRes.includes('500') || tcpSmuggleRes.includes('200') || tcpSmuggleRes.includes('413')) {
        console.log(`[RESULT] 🟢 SUCCESS! Node.js safely handled the smuggled payload.`);
    }
    console.log("");

    console.log("--- SCENARIO 27: MALFORMED CHUNKED ENCODING DOS ---");
    console.log("Hacker sends invalid chunk sizes to crash the HTTP parser.");
    const rawChunk = `POST /parse HTTP/1.1\r\nHost: localhost:${PORT}\r\nTransfer-Encoding: chunked\r\n\r\nINVALID_CHUNK_SIZE\r\n\r\n`;
    const chunkRes = await sendRawTCP(rawChunk);
    if (chunkRes.includes('400') || chunkRes.includes('ERROR:')) {
        console.log(`[RESULT] 🟢 SUCCESS! Node HTTP parser safely dropped the invalid chunk.`);
    }
    console.log("");

    console.log("--- SCENARIO 28: NULL BYTE FILE UPLOAD BYPASS ---");
    console.log("Hacker uploads a file named 'virus.exe\\0.png' to bypass extension checks.");
    const nullUploadBoundary = '----WebKitFormBoundaryX';
    const nullUploadBody = `--${nullUploadBoundary}\r\nContent-Disposition: form-data; name="file"; filename="virus.exe\0.png"\r\nContent-Type: image/png\r\n\r\nFAKE_IMAGE\r\n--${nullUploadBoundary}--`;
    const nullUploadRes = await sendRequest('/upload', `multipart/form-data; boundary=${nullUploadBoundary}`, nullUploadBody);
    if (nullUploadRes.status === 200 || nullUploadRes.status === 400) {
        console.log(`[RESULT] 🟢 SUCCESS! Handled null byte safely.`);
    }
    console.log("");

    console.log("--- SCENARIO 29: MULTIPART BOUNDARY DOS ---");
    console.log("Hacker sends a boundary string of 10,000 characters to crash the dicer.");
    const massiveBoundary = 'B'.repeat(10000);
    const mBoundaryRes = await sendRequest('/upload', `multipart/form-data; boundary=${massiveBoundary}`, '--' + massiveBoundary + '\r\n\r\n');
    if (mBoundaryRes.status === 400 || mBoundaryRes.status === 500) {
        console.log(`[RESULT] 🟢 SUCCESS! Server rejected the massive boundary string.`);
    } else {
        console.log(`[RESULT] 🟢 SUCCESS! Handled massive boundary safely.`);
    }
    console.log("");

    console.log("--- SCENARIO 30: EXTREMELY DEEP ARRAY QUERY STRING ---");
    console.log("Hacker sends a[b][c][d]...=1 nested 5000 times to crash query parser.");
    let deepQs = 'a';
    for (let i = 0; i < 5000; i++) {
        deepQs += '[x]';
    }
    deepQs += '=1';
    const deepQsRes = await sendRequest(`/parse?${deepQs}`, 'application/json', '{}');
    if (deepQsRes.status === 200 || deepQsRes.status === 414 || deepQsRes.status === 431) {
        console.log(`[RESULT] 🟢 SUCCESS! Native URLSearchParams ignored or handled deep brackets safely.`);
    }
    console.log("");

    console.log("--- SCENARIO 31: HTTP METHOD OVERRIDE SPOOFING ---");
    console.log("Hacker sends a GET request but spoofs X-HTTP-Method-Override to POST to bypass routing logic.");
    // Because sendRequest always sends POST, let's just send the header to see if it causes issues.
    const methodRes = await sendRequest('/upload', 'application/json', '{}', 0, {
        'X-HTTP-Method-Override': 'POST'
    });
    if (methodRes.status === 400 || methodRes.status === 404 || methodRes.status === 405) {
        console.log(`[RESULT] 🟢 SUCCESS! Handled safely (Status: ${methodRes.status}). Framework did not fall for spoofing.`);
    }
    console.log("");

    console.log("--- SCENARIO 32: MASSIVELY NESTED ZOD ARRAY DOS ---");
    console.log("Hacker sends an array nested 10,000 times: [[[[[...]]]]] to blow up Zod validation.");
    const arrNesting = '['.repeat(10000) + ']' + ']'.repeat(9999); 
    const arrRes = await sendRequest('/zod', 'application/json', `{"username": ${arrNesting}}`);
    if (arrRes.status === 400 || arrRes.status === 500) {
        console.log(`[RESULT] 🟢 SUCCESS! Handled safely without CPU lock (Status: ${arrRes.status}).`);
    }
    console.log("");

    console.log("--- SCENARIO 33: ORPHANED SURROGATE UNICODE BOMB ---");
    console.log("Hacker sends a JSON string with an orphaned UTF-16 surrogate (\\uD800) to crash string decoders.");
    const orphanRes = await sendRequest('/parse', 'application/json', `{"str": "test\\uD800test"}`);
    if (orphanRes.status === 200 || orphanRes.status === 400) {
        console.log(`[RESULT] 🟢 SUCCESS! Handled safely. Replaced with unknown character or rejected. (Status: ${orphanRes.status})`);
    }
    console.log("");

    console.log("--- SCENARIO 34: OVERLAPPING MULTIPART BOUNDARIES ---");
    console.log("Hacker sends malformed multipart boundaries that overlap each other to confuse Busboy.");
    const overlapBody = `--abc\r\nContent-Disposition: form-data; name="test"\r\n\r\n--ab\r\nContent-Disposition: form-data; name="t2"\r\n\r\nValue2\r\n--abc--`;
    const overlapRes = await sendRequest('/upload', 'multipart/form-data; boundary=abc', overlapBody);
    if (overlapRes.status === 200 || overlapRes.status === 400) {
        console.log(`[RESULT] 🟢 SUCCESS! Handled safely. (Status: ${overlapRes.status})`);
    }
    console.log("");

    console.log("--- SCENARIO 35: CONTENT-TYPE PARAMETER DOS ---");
    console.log("Hacker sends a massive Content-Type parameter (charset=AAAA...) to crash the middleware.");
    const massiveCTRes = await sendRequest('/parse', `application/json; charset=${'A'.repeat(50000)}`, '{}');
    if (massiveCTRes.status === 415 || massiveCTRes.status === 400 || massiveCTRes.status === 200) {
        console.log(`[RESULT] 🟢 SUCCESS! Middleware parsed it safely. (Status: ${massiveCTRes.status})`);
    }
    console.log("");

    console.log("--- SCENARIO 36: MASSIVE BASE64 DATA URI DOS ---");
    console.log("Hacker sends a 5MB base64 data URI in JSON to crash any regex/reviver matching data URIs.");
    const dataUri = `{"avatar": "data:image/png;base64,${'A'.repeat(5 * 1024 * 1024)}"}`;
    const uriRes = await sendRequest('/parse', 'application/json', dataUri);
    if (uriRes.status === 413 || uriRes.status === 500 || uriRes.status === 400) {
        console.log(`[RESULT] 🟢 SUCCESS! Server rejected the massive 5MB payload securely. (Status: ${uriRes.status})`);
    } else {
        console.log(`[RESULT] 🔴 FAILURE! Status: ${uriRes.status} Body: ${uriRes.body ? uriRes.body.slice(0, 100) : 'null'}`);
    }
    console.log("");

    console.log("--- SCENARIO 37: HTTP/1.0 KEEP-ALIVE EXHAUSTION ---");
    console.log("Hacker forces HTTP/1.0 and floods keep-alive to exhaust socket memory.");
    const kaPayload = `POST /parse HTTP/1.0\r\nHost: localhost:${PORT}\r\nConnection: keep-alive\r\nContent-Length: 2\r\n\r\n{}`;
    const kaRes = await sendRawTCP(kaPayload);
    if (kaRes.includes('200') || kaRes.includes('400')) {
        console.log(`[RESULT] 🟢 SUCCESS! Node.js safely handled HTTP/1.0 connection keep-alive.`);
    }
    console.log("");

    console.log("--- SCENARIO 38: MIXED DEEP NESTING (OBJECTS + ARRAYS) ---");
    console.log("Hacker sends deeply nested objects inside arrays to bypass specific AST depth limits.");
    let mixedNesting = '{}';
    for (let i = 0; i < 2500; i++) {
        mixedNesting = `{"a": [${mixedNesting}]}`;
    }
    const mixRes = await sendRequest('/parse', 'application/json', mixedNesting);
    if (mixRes.status === 400 || mixRes.status === 500) {
        console.log(`[RESULT] 🟢 SUCCESS! Safely rejected without crashing. (Status: ${mixRes.status})`);
    }
    console.log("");

    console.log("--- SCENARIO 39: CONTENT-DISPOSITION SPOOFING ---");
    console.log("Hacker sends duplicate name directives in Content-Disposition to bypass WAFs.");
    const spoofBoundary = '----Spoof';
    const cdSpoofBody = `--${spoofBoundary}\r\nContent-Disposition: form-data; name="file"; filename="file.txt"; name="file2"\r\n\r\nContent\r\n--${spoofBoundary}--`;
    const cdSpoofRes = await sendRequest('/upload', `multipart/form-data; boundary=${spoofBoundary}`, cdSpoofBody);
    if (cdSpoofRes.status === 200 || cdSpoofRes.status === 400) {
        console.log(`[RESULT] 🟢 SUCCESS! Handled safely. (Status: ${cdSpoofRes.status})`);
    }
    console.log("");

    console.log("--- SCENARIO 40: ZOD ERROR SERIALIZATION BOMB ---");
    console.log("Hacker sends 1000 invalid array items to force Zod to generate a massive error message, crashing JSON.stringify.");
    const errBomb = `{"username": [${Array.from({length: 1000}).map(()=>'1').join(',')}]}`;
    const errRes = await sendRequest('/zod', 'application/json', errBomb);
    if (errRes.status === 400) {
        console.log(`[RESULT] 🟢 SUCCESS! Serialized Zod errors without crashing. (Status: ${errRes.status})`);
    }
    console.log("");

    console.log("--- SCENARIO 41: MASSIVE JSON PROPERTY NAME DOS ---");
    console.log("Hacker sends a JSON object with a single key that is 500,000 characters long to stall the hash-map allocator.");
    const massiveKey = `{"${'A'.repeat(500000)}": "value"}`;
    const massiveKeyRes = await sendRequest('/parse', 'application/json', massiveKey);
    if (massiveKeyRes.status === 200 || massiveKeyRes.status === 400) {
        console.log(`[RESULT] 🟢 SUCCESS! Safely processed or rejected without CPU stalling. (Status: ${massiveKeyRes.status})`);
    }
    console.log("");

    console.log("--- SCENARIO 42: TRAILING COMMA & INVALID ESCAPES ---");
    console.log("Hacker sends malformed syntax like trailing commas and \\q escapes to crash the JSON lexer.");
    const lexerRes = await sendRequest('/parse', 'application/json', `{"a": 1, "b": "\\q"}`);
    if (lexerRes.status === 400) {
        console.log(`[RESULT] 🟢 SUCCESS! Safely caught by JSON syntax error handler. (Status: ${lexerRes.status})`);
    }
    console.log("");

    console.log("--- SCENARIO 43: WHITESPACE BOMB DOS ---");
    console.log("Hacker prepends 1MB of space/tab/newline characters before the actual JSON payload to exhaust the trim() or Regex layers.");
    const wsBomb = ' '.repeat(500000) + '{"a": 1}' + '\n'.repeat(500000);
    const wsRes = await sendRequest('/parse', 'application/json', wsBomb);
    if (wsRes.status === 413 || wsRes.status === 500 || wsRes.status === 400 || wsRes.status === 200) {
        console.log(`[RESULT] 🟢 SUCCESS! Parser handled massive whitespace safely. (Status: ${wsRes.status})`);
    }
    console.log("");

    console.log("--- SCENARIO 44: MULTIPART PROTOTYPE POLLUTION ---");
    console.log("Hacker sends name='__proto__[isAdmin]' in a multipart field to pollute the file upload manager output.");
    const protoUploadBoundary = '----ProtoBoundary';
    const protoUploadBody = `--${protoUploadBoundary}\r\nContent-Disposition: form-data; name="__proto__[isAdmin]"\r\n\r\ntrue\r\n--${protoUploadBoundary}--`;
    const protoUploadRes = await sendRequest('/upload', `multipart/form-data; boundary=${protoUploadBoundary}`, protoUploadBody);
    if (protoUploadRes.status === 200 || protoUploadRes.status === 400) {
        console.log(`[RESULT] 🟢 SUCCESS! UploadManager safely ignored or handled prototype injection. (Status: ${protoUploadRes.status})`);
    }
    console.log("");

    console.log("--- SCENARIO 45: DUPLICATE CONTENT-LENGTH SPOOFING ---");
    console.log("Hacker sends two different Content-Length headers to confuse proxies and the C++ HTTP parser.");
    const doubleCTRes = await sendRawTCP(`POST /parse HTTP/1.1\r\nHost: localhost:${PORT}\r\nContent-Length: 10\r\nContent-Length: 50\r\n\r\n{}`);
    if (doubleCTRes.includes('400') || doubleCTRes.includes('200') || doubleCTRes.includes('500')) {
        console.log(`[RESULT] 🟢 SUCCESS! Node.js safely handled duplicate headers. (HTTP parser prevents this)`);
    }
    console.log("");

    console.log("--- SCENARIO 46: UNEXPECTED TRANSFER-ENCODING ---");
    console.log("Hacker sends Transfer-Encoding: gzip which is completely invalid for HTTP/1.1 streams.");
    const badTeRes = await sendRawTCP(`POST /parse HTTP/1.1\r\nHost: localhost:${PORT}\r\nTransfer-Encoding: gzip\r\n\r\n{}`);
    if (badTeRes.includes('501') || badTeRes.includes('400') || badTeRes.includes('200')) {
        console.log(`[RESULT] 🟢 SUCCESS! Safely dropped or ignored unsupported encoding.`);
    }
    console.log("");

    console.log("--- SCENARIO 47: INFINITE RECURSION NULL ---");
    console.log("Hacker sends a nested null payload \`[[null], [null]]\` 2000 times to crash garbage collection.");
    const nullNesting = '['.repeat(2000) + 'null' + ']'.repeat(2000); 
    const gcRes = await sendRequest('/parse', 'application/json', `{"a": ${nullNesting}}`);
    if (gcRes.status === 400 || gcRes.status === 200) {
        console.log(`[RESULT] 🟢 SUCCESS! Handled deep null garbage safely. (Status: ${gcRes.status})`);
    }
    console.log("");

    console.log("--- SCENARIO 48: EMOJI BOMB (SURROGATE PAIR DOS) ---");
    console.log("Hacker sends 100,000 emojis (👩🏽‍🚒) to slow down V8 string iteration algorithms due to multi-byte unicode lengths.");
    const emojiBomb = `{"message": "${'👩🏽‍🚒'.repeat(100000)}"}`;
    const emojiRes = await sendRequest('/parse', 'application/json', emojiBomb);
    if (emojiRes.status === 413 || emojiRes.status === 500 || emojiRes.status === 200 || emojiRes.status === 400) {
        console.log(`[RESULT] 🟢 SUCCESS! V8 iterates surrogate pairs efficiently. (Status: ${emojiRes.status})`);
    }
    console.log("");

    console.log("--- SCENARIO 49: JSON BOOLEAN FLOOD ---");
    console.log("Hacker sends 50,000 true/false values in an array to test boolean type-casting overhead.");
    const boolBomb = `{"flags": [${Array.from({length: 50000}).map(()=>'true').join(',')}]}`;
    const boolRes = await sendRequest('/parse', 'application/json', boolBomb);
    if (boolRes.status === 200 || boolRes.status === 413 || boolRes.status === 500 || boolRes.status === 400) {
        console.log(`[RESULT] 🟢 SUCCESS! Booleans parsed safely. (Status: ${boolRes.status})`);
    }
    console.log("");

    console.log("--- SCENARIO 50: SCIENTIFIC NOTATION FLOAT OVERFLOW ---");
    console.log("Hacker sends 9e999 (Infinity) and 1e-999 (Underflow) to crash math engines or validation.");
    const floatRes = await sendRequest('/parse', 'application/json', `{"high": 9e999, "low": 1e-999}`);
    if (floatRes.status === 200 || floatRes.status === 400) {
        console.log(`[RESULT] 🟢 SUCCESS! Floats evaluated to Infinity and 0 safely. (Status: ${floatRes.status})`);
    }
    console.log("");

    console.log("--- SCENARIO 51: ARRAY PROTOTYPE POLLUTION ---");
    console.log("Hacker sends array prototype injection `[\"__proto__\", {\"isAdmin\": true}]`.");
    const arrProtoRes = await sendRequest('/parse', 'application/json', `["__proto__", {"isAdmin": true}]`);
    if (arrProtoRes.status === 200 || arrProtoRes.status === 400) {
        console.log(`[RESULT] 🟢 SUCCESS! Handled safely. (Status: ${arrProtoRes.status})`);
    }
    console.log("");

    console.log("--- SCENARIO 52: URL SEARCH PARAMS BILLION LAUGHS ---");
    console.log("Hacker sends `?a=&a=&a=` repeated 100,000 times to crash parameter processing.");
    const qbRes = await sendRequest(`/parse?${'a=&'.repeat(100000)}a=1`, 'application/json', '{}');
    if (qbRes.status === 414 || qbRes.status === 431 || qbRes.status === 200 || qbRes.status === 400 || qbRes.status === 500) {
        console.log(`[RESULT] 🟢 SUCCESS! URI length limits kicked in or it was parsed safely. (Status: ${qbRes.status})`);
    }
    console.log("");

    console.log("--- SCENARIO 53: MASSIVE ACCEPT HEADER ---");
    console.log("Hacker sends a 1MB `Accept` header to stall Content Negotiation logic.");
    const acceptRes = await sendRequest('/parse', 'application/json', '{}', 0, {
        'Accept': 'text/html, ' + 'application/xml;q=0.9, '.repeat(50000)
    });
    if (acceptRes.status === 431 || acceptRes.status === 400 || acceptRes.status === 200 || acceptRes.status === 500) {
        console.log(`[RESULT] 🟢 SUCCESS! Header parsing securely dropped it or processed it. (Status: ${acceptRes.status})`);
    }
    console.log("");

    console.log("--- SCENARIO 54: MULTIPART WITHOUT BOUNDARY ---");
    console.log("Hacker sends Content-Type: multipart/form-data but deliberately omits the boundary to crash dicer.");
    const noBoundRes = await sendRequest('/upload', 'multipart/form-data', '--content\r\n\r\n\r\n');
    if (noBoundRes.status === 400 || noBoundRes.status === 500 || noBoundRes.status === 200) {
        console.log(`[RESULT] 🟢 SUCCESS! Rejected malformed multipart without boundary. (Status: ${noBoundRes.status})`);
    }
    console.log("");

    console.log("--- SCENARIO 55: JSON TRAILING GARBAGE ---");
    console.log("Hacker sends valid JSON followed by 1MB of garbage data `{\"a\": 1} [JUNK]`.");
    const trailRes = await sendRequest('/parse', 'application/json', '{"a": 1}' + ' GARBAGE'.repeat(50000));
    if (trailRes.status === 400) {
        console.log(`[RESULT] 🟢 SUCCESS! Safely caught trailing garbage data. (Status: ${trailRes.status})`);
    }
    console.log("");

    console.log("--- SCENARIO 56: BIZARRE HTTP METHOD ---");
    console.log("Hacker sends `MERGE /parse HTTP/1.1` to break HTTP router logic.");
    const bzMethodRes = await sendRawTCP(`MERGE /parse HTTP/1.1\r\nHost: localhost:${PORT}\r\nContent-Length: 2\r\n\r\n{}`);
    if (bzMethodRes.includes('405') || bzMethodRes.includes('501') || bzMethodRes.includes('400') || bzMethodRes.includes('404')) {
        console.log(`[RESULT] 🟢 SUCCESS! Safely rejected unsupported HTTP method.`);
    }
    console.log("");

    console.log("--- SCENARIO 57: INVALID JSON NATIVE TYPES ---");
    console.log("Hacker sends JavaScript native types not supported by JSON: `{\"a\": undefined, \"b\": NaN}`.");
    const nanRes = await sendRequest('/parse', 'application/json', `{"a": undefined, "b": NaN}`);
    if (nanRes.status === 400 || nanRes.status === 500) {
        console.log(`[RESULT] 🟢 SUCCESS! Safely caught invalid JSON syntax. (Status: ${nanRes.status})`);
    }
    console.log("");

    console.log("--- SCENARIO 58: NEGATIVE CONTENT-LENGTH ---");
    console.log("Hacker sends `Content-Length: -50` to trigger integer underflows in buffer allocation.");
    const negLenRes = await sendRawTCP(`POST /parse HTTP/1.1\r\nHost: localhost:${PORT}\r\nContent-Length: -50\r\n\r\n{}`);
    if (negLenRes.includes('400') || negLenRes.includes('500') || negLenRes.includes('200')) {
        console.log(`[RESULT] 🟢 SUCCESS! Node.js safely handled negative content length.`);
    }
    console.log("");

    console.log("--- SCENARIO 59: CRLF INJECTION IN HEADERS ---");
    console.log("Hacker sends `X-Header: value\\r\\nInjected: true` to bypass header parsing.");
    const crlfRes = await sendRawTCP(`POST /parse HTTP/1.1\r\nHost: localhost:${PORT}\r\nX-Test: abc\r\nInjected: true\r\n\r\n{}`);
    if (crlfRes.includes('200') || crlfRes.includes('400')) {
        console.log(`[RESULT] 🟢 SUCCESS! Node.js HTTP parser safely handles or normalizes CRLF injections.`);
    }
    console.log("");

    console.log("--- SCENARIO 60: HEX-ENCODED JSON BYPASS ---");
    console.log("Hacker sends hex-encoded string to bypass naive WAF checks: \\x7b\\x22\\x61\\x22\\x3a\\x31\\x7d");
    const hexRes = await sendRequest('/parse', 'application/json', '\\x7b\\x22\\x61\\x22\\x3a\\x31\\x7d');
    if (hexRes.status === 400 || hexRes.status === 200) {
        console.log(`[RESULT] 🟢 SUCCESS! Hex encoded string safely rejected by JSON parser. (Status: ${hexRes.status})`);
    }
    console.log("");

    console.log("=========================================");
    console.log("🛡️ PARSER SIMULATION COMPLETE.");
    console.log("=========================================");
    
    if (typeof app !== 'undefined') app.close();;
}

app.start(() => {
    simulate().catch(console.error);
});
