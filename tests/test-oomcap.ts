// Quick OOM cap test for brute-force store
import * as net from 'node:net';
import { Server, post } from '../src/index';
import { bruteForce } from '../src/security/brute-force';

const PORT = 3098;
const app = new Server({ port: PORT });

// maxMemoryKeys capped at 5 intentionally
app.register(
    post('/test', bruteForce({ maxFailures: 100, lockoutTimeMs: 5000, maxMemoryKeys: 5 }), async (ctx) => {
        return ctx.json({ ok: true });
    })
);

app.start(async () => {
    const results: string[] = [];
    for (let i = 0; i < 15; i++) {
        const b = JSON.stringify({ username: `u${i}@test.com`, password: 'x' });
        const r = await new Promise<string>((resolve) => {
            const c = net.createConnection({ port: PORT }, () => {
                c.write(`POST /test HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: ${b.length}\r\n\r\n${b}`);
            });
            let d = '';
            c.on('data', x => d += x);
            c.on('end', () => resolve(d.split('\r\n')[0]));
            c.on('error', e => resolve('ERR:' + e.message));
        });
        results.push(`u${i}: ${r}`);
    }
    console.log('Results:');
    results.forEach(r => console.log(' ', r));
    if (typeof app !== 'undefined') app.close();;
});
