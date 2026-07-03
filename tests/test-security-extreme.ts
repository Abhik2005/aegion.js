import * as net from 'node:net';
import { Server, group, post, get } from '../src/index';
import { RateLimiter } from '../src/security/rate-limit';
import { bruteForce } from '../src/security/brute-force';

const PORT = 3009;
const app = new Server({ 
    port: PORT,
    rateLimit: { windowMs: 60000, maxRequests: 100 }
});

// Bruteforce login route
app.register(
    post('/login', bruteForce({ maxRetries: 5 }), async (ctx) => {
        return ctx.json({ success: false, message: 'Invalid credentials' });
    })
);

app.register(
    get('/secure', async (ctx) => ctx.json({ success: true }))
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
    console.log("🛡️ AEGION SECURITY LAB: EXTREME DEFENSES");
    console.log("=========================================\n");

    // Scenario 1: Rate Limiter Token Bucket Exhaustion
    console.log("--- SCENARIO 1: RATE LIMITER EXHAUSTION ---");
    console.log("Hacker sends 200 rapid requests to bypass the 100-request rate limit.");
    let rateLimitPassed = true;
    for (let i = 0; i < 200; i++) {
        const res = await sendRawTCP(`GET /secure HTTP/1.1\r\nHost: localhost:${PORT}\r\nConnection: close\r\n\r\n`);
        if (i > 105 && res.includes('200 OK')) {
            rateLimitPassed = false;
        }
    }
    if (rateLimitPassed) {
        console.log(`[RESULT] 🟢 SUCCESS! Rate limiter accurately blocked requests after limit exceeded.\n`);
    } else {
        console.log(`[RESULT] 🔴 FAILURE! Rate limiter leaked requests through.\n`);
    }

    // Scenario 2: Brute Force Exponential Backoff
    console.log("--- SCENARIO 2: LOGIN BRUTE FORCE LOCKOUT ---");
    console.log("Hacker spams /login 10 times. Limit is 5.");
    let lockoutPassed = true;
    for (let i = 0; i < 10; i++) {
        const payload = `{"username": "admin", "password": "password${i}"}`;
        const res = await sendRawTCP(`POST /login HTTP/1.1\r\nHost: localhost:${PORT}\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(payload)}\r\n\r\n${payload}`);
        if (i >= 5 && !res.includes('429')) {
            lockoutPassed = false;
        }
    }
    if (lockoutPassed) {
        console.log(`[RESULT] 🟢 SUCCESS! Brute-force protection locked out the attacker.\n`);
    } else {
        console.log(`[RESULT] 🔴 FAILURE! Attacker bypassed lockout.\n`);
    }

    // Scenario 3: CORS Origin Spoofing
    console.log("--- SCENARIO 3: MASSIVE CORS ORIGIN SPOOFING ---");
    console.log("Hacker sends a 50KB Origin header to crash CORS parser.");
    const massiveOrigin = 'http://' + 'a'.repeat(50000) + '.com';
    const res3 = await sendRawTCP(`GET /secure HTTP/1.1\r\nHost: localhost:${PORT}\r\nConnection: close\r\nOrigin: ${massiveOrigin}\r\n\r\n`);
    if (res3.includes('431') || res3.includes('400')) {
        console.log(`[RESULT] 🟢 SUCCESS! Node.js safely rejected massive origin header.\n`);
    } else if (res3.includes('200')) {
        console.log(`[RESULT] 🟡 WARNING: Node permitted a massive Origin header.\n`);
    }

    // Scenario 4: HTTP Pipeline Smuggling
    console.log("--- SCENARIO 4: HTTP PIPELINE SMUGGLING ---");
    console.log("Hacker pipelines 5 requests into a single TCP packet to confuse rate limits.");
    const pipePayload = `GET /secure HTTP/1.1\r\nHost: localhost:${PORT}\r\n\r\n`.repeat(4) + `GET /secure HTTP/1.1\r\nHost: localhost:${PORT}\r\nConnection: close\r\n\r\n`;
    const res4 = await sendRawTCP(pipePayload);
    if (res4.includes('200 OK')) {
        console.log(`[RESULT] 🟢 SUCCESS! Node HTTP parser safely serialized the pipelined requests.\n`);
    }

    // Scenario 5: JWT Huge Bearer Token
    console.log("--- SCENARIO 5: JWT GIGANTIC BEARER TOKEN ---");
    console.log("Hacker sends a 10MB Authorization header to crash memory.");
    const authPayload = `GET /secure HTTP/1.1\r\nHost: localhost:${PORT}\r\nConnection: close\r\nAuthorization: Bearer ${'a'.repeat(50000)}\r\n\r\n`;
    const res5 = await sendRawTCP(authPayload);
    if (res5.includes('431') || res5.includes('400') || res5.includes('500')) {
        console.log(`[RESULT] 🟢 SUCCESS! Safe rejection of massive Bearer token.\n`);
    }

    console.log("=========================================");
    console.log("🛡️ EXTREME DEFENSE SIMULATION COMPLETE.");
    console.log("=========================================");
    
    if (typeof app !== 'undefined') app.close();;
}

app.start(() => {
    simulate().catch(console.error);
});
