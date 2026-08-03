import { Server } from '../src/server';
import autocannon from 'autocannon';

async function run() {
    const app = new Server({ port: 3001 });

    // Pure Hello World route with zero middleware
    app.register([{
        method: 'GET',
        path: '/',
        middlewares: [],
        handler: async (ctx) => {
            ctx.json({ hello: 'world' });
        }
    }]);

    app.start(async () => {
        console.log('🚀 Starting Pure "Hello World" Load Test on http://localhost:3001/');
        
        const instance = autocannon({
            url: 'http://localhost:3001/',
            connections: 100,
            duration: 10,
        }, () => {});

        autocannon.track(instance, { renderProgressBar: true });

        instance.on('done', (result) => {
            console.log('\n--- Barebones Benchmark Results ---');
            console.log(`Total Requests: ${result.requests.total}`);
            console.log(`Average RPS: ${result.requests.average}`);
            console.log(`P99 Latency: ${result.latency.p99}ms`);
            console.log(`Errors: ${result.errors}`);
            console.log('-----------------------------------');
            process.exit(0);
        });
    });
}

run().catch(console.error);
