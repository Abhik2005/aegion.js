import autocannon from 'autocannon';
import { Server } from '../src/server.js';
import { Context } from '../src/context.js';

// Configuration
const PORT = 3000;
const URL = `http://localhost:${PORT}/`;
const MIN_ACCEPTABLE_RPS = 2000;
const DURATION = 10;
const CONNECTIONS = 100;

// Setup Server
const server = new Server();
server.router.register([{
    method: 'GET',
    path: '/',
    handler: async (ctx: Context) => { ctx.res.end('Hello Benchmark!'); },
    middlewares: []
}]);

server.start(async () => {
    console.log(`\n🚀 Starting Enterprise Load Test on ${URL}`);
    console.log(`Duration: ${DURATION}s | Connections: ${CONNECTIONS}`);

    const instance = autocannon({
        url: URL,
        connections: CONNECTIONS,
        duration: DURATION
    });

    autocannon.track(instance);

    instance.on('done', (result) => {
        server.close();
        
        console.log('\n--- Benchmark Results ---');
        console.log(`Total Requests: ${result.requests.total}`);
        console.log(`Average RPS: ${result.requests.average}`);
        console.log(`P99 Latency: ${result.latency.p99}ms`);
        console.log(`Errors: ${result.errors}`);
        console.log('-------------------------\n');

        if (result.requests.average < MIN_ACCEPTABLE_RPS) {
            console.error(`❌ FAILED: Average RPS (${result.requests.average}) is below minimum acceptable threshold (${MIN_ACCEPTABLE_RPS})`);
            process.exit(1);
        } else {
            console.log(`✅ PASSED: Average RPS is above the baseline threshold.`);
            process.exit(0);
        }
    });
});
