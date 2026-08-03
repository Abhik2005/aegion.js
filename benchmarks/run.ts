import autocannon from 'autocannon';
import { server } from './server.js';
import * as util from 'node:util';

const autocannonAsync = util.promisify(autocannon);

const PORT = 3000;
const BASE_URL = `http://localhost:${PORT}`;

const DURATION = 30; // 30 seconds of sustained heavy load per endpoint
const CONNECTIONS = 1000; // 1000 concurrent socket connections
const PIPELINING = 10; // 10 pipelined requests per connection

interface BenchmarkConfig {
    name: string;
    url: string;
    method: 'GET' | 'POST' | 'PUT' | 'DELETE';
    body?: string;
    headers?: Record<string, string>;
}

const suite: BenchmarkConfig[] = [
    {
        name: 'Health Check (Raw Routing, No Auth Middleware)',
        url: `${BASE_URL}/api/health`,
        method: 'GET'
    },
    {
        name: 'Dynamic Param Extraction',
        url: `${BASE_URL}/api/users/999`,
        method: 'GET'
    },
    {
        name: 'Login (JSON Body + Session Creation)',
        url: `${BASE_URL}/api/auth/login`,
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'test@example.com', password: 'password123' })
    },
    {
        name: 'Complex Search (NoSQL Sanitizer Stress Test)',
        url: `${BASE_URL}/api/search`,
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // A deeply nested object designed to force the recursive NoSQL sanitizer to do work
        body: JSON.stringify({
            query: {
                nested: {
                    level1: {
                        level2: {
                            field: 'value',
                            array: [{ safe: true }, { safe: false }]
                        }
                    }
                }
            },
            filter: {
                status: 'active',
                roles: ['admin', 'user']
            }
        })
    }
];

async function runBenchmarks() {
    console.log(`\n🚀 Starting Aegion.js Production Benchmark Suite`);
    console.log(`Testing against: ${BASE_URL}`);
    console.log(`Configuration: ${CONNECTIONS} concurrent connections, ${DURATION}s per endpoint\n`);

    for (const test of suite) {
        console.log(`\n▶ Running: ${test.name}`);
        console.log(`  ${test.method} ${test.url}`);
        
        try {
            const result = await autocannonAsync({
                url: test.url,
                method: test.method,
                body: test.body,
                headers: test.headers,
                connections: CONNECTIONS,
                pipelining: PIPELINING,
                duration: DURATION
            }) as autocannon.Result;

            console.log(`  Result: ${result.requests.average} req/sec | Avg Latency: ${result.latency.average}ms | Errors: ${result.errors}`);
        } catch (e) {
            console.error(`  ❌ Test failed:`, e);
        }
    }

    console.log(`\n✅ Benchmark Suite Completed!`);
    
    server.close();
    process.exit(0);
}

// Start the server, then run tests
server.start(() => {
    runBenchmarks();
});
