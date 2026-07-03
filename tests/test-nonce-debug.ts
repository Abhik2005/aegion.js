import * as net from 'node:net';
import * as crypto from 'node:crypto';
import { Server, get } from '../src/index';

const app = new Server({ port: 3088 });
app.register(
    get('/csp-nonce', async (ctx) => {
        const nonce = crypto.randomBytes(16).toString('base64');
        ctx.res.setHeader('Content-Security-Policy', `default-src 'self'; script-src 'self' 'nonce-${nonce}'`);
        return ctx.json({ nonce });
    })
);

app.start(() => {
    setTimeout(async () => {
        const r = await new Promise<string>(res => {
            const c = net.createConnection({ port: 3088 }, () => {
                c.write('GET /csp-nonce HTTP/1.1\r\nHost: localhost:3088\r\nConnection: close\r\n\r\n');
            });
            let d = '';
            c.on('data', x => d += x);
            c.on('end', () => res(d));
            c.on('error', e => res('ERR: ' + e.message));
        });
        console.log('Full response:\n', r);
        if (typeof app !== 'undefined') app.close();;
    }, 500);
});
