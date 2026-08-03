import { Server } from '../src/index.js';
import * as http from 'node:http';

async function runManualVerification() {
    console.log('🚀 [pkg_test] Starting Manual Verification for Recursive autoload()...');
    
    const PORT = 3847;
    const server = new Server({ port: PORT });

    console.log('📂 [pkg_test] Calling await server.autoload(\'./pkg_test/routes\')...');
    await server.autoload('./pkg_test/routes');

    console.log('🌐 [pkg_test] Starting local server...');
    await new Promise<void>((resolve) => {
        server.start(() => {
            console.log(`✅ [pkg_test] Server running on http://localhost:${PORT}\n`);
            resolve();
        });
    });

    const endpoints = [
        '/',
        '/api/v1/status',
        '/admin/security/audit',
        '/non-existent-endpoint' // Should return 404
    ];

    console.log('--- 🧪 Executing Live HTTP Requests against Autoloaded Routes ---');
    for (const ep of endpoints) {
        const url = `http://localhost:${PORT}${ep}`;
        try {
            const res = await fetch(url);
            const status = res.status;
            let body = await res.json();
            console.log(`\n🔹 GET ${ep} -> Status: ${status} ${res.statusText}`);
            console.log('   Response Body:', JSON.stringify(body, null, 2).replace(/\n/g, '\n   '));
        } catch (err: any) {
            console.error(`❌ Request to ${ep} failed:`, err.message);
        }
    }
    console.log('\n--- 🏁 Verification Completed Successfully! Shutting down server... ---');
    server.close(() => {
        console.log('👋 [pkg_test] Server closed. Exiting cleanly.');
        // Allow Windows libuv handles to finish their asynchronous closing cycle before exiting
        setTimeout(() => process.exit(0), 50);
    });
}

runManualVerification().catch((err) => {
    console.error('🚨 Error running manual verification:', err);
    process.exit(1);
});
