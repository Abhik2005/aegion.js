import { performance } from 'node:perf_hooks';
import * as http from 'node:http';
import { Socket } from 'node:net';
import { Context } from '../src/context.js';
import { SessionManager } from '../src/session.js';
import { CookieManager } from '../src/cookie.js';
import * as crypto from 'node:crypto';

const secret = crypto.randomBytes(32).toString('hex');

function simulateRequest(cookieHeader?: string) {
    const req = new http.IncomingMessage(new Socket());
    if (cookieHeader) req.headers.cookie = cookieHeader;
    const res = new http.ServerResponse(req);
    const cookieMgr = new CookieManager(req, res, secret);
    // 0-second access token to force constant rotation in the benchmark
    return new SessionManager(cookieMgr, secret, { accessExpiresIn: -1 });
}

function runTorturePhase(phaseName: string, totalRequests: number, concurrency: number) {
    console.log(`\n--- [PHASE: ${phaseName}] ---`);
    console.log(`Target: ${totalRequests.toLocaleString()} JWT Lifecycle Events | Batch Size: ${concurrency.toLocaleString()}`);
    
    // First, generate a valid Refresh Token by doing a normal login
    const setupMgr = simulateRequest();
    setupMgr.create({ userId: 999, role: 'admin', permissionMatrix: [1, 2, 3, 4, 5] });
    const cookies = (setupMgr as any).cookie.res.getHeader('Set-Cookie') as string[];
    // We only take the refresh token so every request is forced to cryptographically rotate
    const refreshCookie = cookies.find(c => c.startsWith('aegion_refresh='))!.split(';')[0];
    
    const startMemory = process.memoryUsage().heapUsed;
    const startTime = performance.now();
    let completed = 0;
    
    for (let i = 0; i < totalRequests; i += concurrency) {
        const batchSize = Math.min(concurrency, totalRequests - i);
        
        for (let j = 0; j < batchSize; j++) {
            const mgr = simulateRequest(refreshCookie);
            
            // This forces the engine to:
            // 1. Verify the Refresh Token signature (HMAC SHA-256)
            // 2. Decode the payload
            // 3. Generate a NEW Access Token (Sign HMAC SHA-256)
            // 4. Generate a NEW Refresh Token (Sign HMAC SHA-256)
            // 5. Serialize both into strict HttpOnly strings
            const session = mgr.get();
            if (!session || session.userId !== 999) {
                console.error("FATAL ERROR: Cryptographic verification failure or rotation drop!");
                if (typeof app !== 'undefined') app.close(); throw new Error('Test Failed');;
            }
        }
        
        completed += batchSize;
        const logInterval = Math.max(10000, Math.floor(totalRequests / 10)); // Log every 10% or 10k
        if (completed % logInterval === 0 || completed === totalRequests) {
            console.log(`... Processed ${completed.toLocaleString()} / ${totalRequests.toLocaleString()} ...`);
        }
    }
    
    const endTime = performance.now();
    const endMemory = process.memoryUsage().heapUsed;
    const durationMs = endTime - startTime;
    const opsPerSec = Math.floor(totalRequests / (durationMs / 1000));
    const memoryGrowthMB = (endMemory - startMemory) / 1024 / 1024;
    
    console.log(`✅ Phase Survived! Speed: ${opsPerSec.toLocaleString()} ops/sec | Memory Spiked: ${memoryGrowthMB.toFixed(2)} MB`);
}

function startTortureTest() {
    console.log('--- Aegion Absolute Breaking Point (JWT Cryptographic Engine) ---');
    console.log('Pushing V8 Engine to allocate & sign millions of simultaneous HMAC-SHA256 tokens...\n');
    
    try {
        runTorturePhase("Level 1 (Warmup)", 100_000, 10_000);
        runTorturePhase("Level 2 (Aggressive)", 500_000, 50_000);
        runTorturePhase("Level 3 (Brutal Cryptography)", 1_000_000, 100_000);
        
        console.log('\n🚨 SERVER SURVIVED 1,000,000 FULL CRYPTOGRAPHIC ROTATIONS WITHOUT OOM.');
    } catch (e: any) {
        console.error(`\n💀 SERVER CRASHED! Breaking point reached.`);
        console.error(e.message || e);
    }
}

try {
    startTortureTest();
} catch (e) {
    console.error(`\n💀 FATAL V8 ENGINE CRASH! Breaking point reached.`);
    console.error(e);
}
