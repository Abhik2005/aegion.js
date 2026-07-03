import { performance } from 'node:perf_hooks';
import * as http from 'node:http';
import { Socket } from 'node:net';
import { Context } from '../src/context.js';
import { csp } from '../src/security/csp.js';

function createMockContext(): Context {
    const req = new http.IncomingMessage(new Socket());
    const res = new http.ServerResponse(req);
    const ctx = new Context(req, res, 'pipeline-secret-32-chars-long-min!!!');
    ctx.next = () => Symbol('CONTINUE_PIPELINE');
    return ctx;
}

const complexMiddleware = csp({
    useNonce: true,
    directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "https://js.stripe.com", "https://maps.googleapis.com", "'strict-dynamic'"],
        styleSrc: ["'self'", "https://fonts.googleapis.com", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:", "https://images.unsplash.com"],
        connectSrc: ["'self'", "wss://api.example.com"],
    }
});

async function runTorturePhase(phaseName: string, totalRequests: number, concurrency: number) {
    console.log(`\n--- [PHASE: ${phaseName}] ---`);
    console.log(`Target: ${totalRequests.toLocaleString()} requests | Concurrency: ${concurrency.toLocaleString()}`);
    
    const startMemory = process.memoryUsage().heapUsed;
    const startTime = performance.now();
    let completed = 0;
    
    for (let i = 0; i < totalRequests; i += concurrency) {
        const batchSize = Math.min(concurrency, totalRequests - i);
        const promises = [];
        
        for (let j = 0; j < batchSize; j++) {
            const ctx = createMockContext();
            promises.push(complexMiddleware(ctx));
        }
        
        try {
            await Promise.all(promises);
        } catch (err) {
            console.error("FATAL ERROR IN BATCH:", err);
            if (typeof app !== 'undefined') app.close(); throw new Error('Test Failed');;
        }
        
        completed += batchSize;
        if (completed % 1000000 === 0) {
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

async function startTortureTest() {
    console.log('--- Aegion Absolute Breaking Point (Torture Test) ---');
    console.log('Pushing V8 Engine to mathematical destruction to find the exact crash limit...\n');
    
    try {
        // Phase 1: The standard 1 Million
        await runTorturePhase("Level 1 (Warmup)", 1_000_000, 10_000);
        
        // Phase 2: 5 Million
        await runTorturePhase("Level 2 (Aggressive)", 5_000_000, 50_000);
        
        // Phase 3: 10 Million
        await runTorturePhase("Level 3 (Brutal)", 10_000_000, 100_000);
        
        // Phase 4: 25 Million, pushing 250k promises at once into memory
        await runTorturePhase("Level 4 (Insane)", 25_000_000, 250_000);
        
        // Phase 5: 50 Million, pushing 1,000,000 concurrent promises at exactly the same time
        await runTorturePhase("Level 5 (Death Limit)", 50_000_000, 1_000_000);
        
        console.log('\n🚨 IMPOSSIBLE: The server survived 50 Million requests without crashing.');
    } catch (e: any) {
        console.error(`\n💀 SERVER CRASHED! Breaking point reached.`);
        console.error(e.message || e);
    }
}

startTortureTest().catch(e => {
    console.error(`\n💀 FATAL V8 ENGINE CRASH! Breaking point reached.`);
    console.error(e);
});
