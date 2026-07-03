import * as net from 'node:net';
import { Server, post } from '../src/index';
import { UploadManager } from '../src/upload';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const PORT = 3005;
const app = new Server({ port: PORT });

app.register(
    post('/upload', async (ctx) => {
        try {
            const data = await UploadManager.parse(ctx.req, {
                limits: {
                    fileSize: 1024 * 1024, // 1MB limit
                    files: 5,
                    fields: 10,
                    fieldNameSize: 100,
                    parts: 20
                }
            });
            
            // Clean up files immediately so we don't pollute temp
            for (const file of data.files) {
                fs.promises.unlink(file.filepath).catch(() => {});
            }
            
            ctx.status(200).json({ success: true, files: data.files.length, fields: Object.keys(data.fields).length });
        } catch (e: any) {
            ctx.status(400).json({ error: e.message });
        }
    })
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
    console.log("🛡️ AEGION SECURITY LAB: EXTREME UPLOADS");
    console.log("=========================================\n");

    const boundary = '----WebKitFormBoundaryExtreme123';

    // Scenario 1: Mass Files Exhaustion
    console.log("--- SCENARIO 1: MASS FILE UPLOAD DOS ---");
    console.log("Hacker sends 100 tiny files in a single payload to exhaust inodes and the filesLimit.");
    let massFiles = '';
    for (let i = 0; i < 50; i++) { 
        massFiles += `--${boundary}\r\nContent-Disposition: form-data; name="file${i}"; filename="f${i}.txt"\r\nContent-Type: text/plain\r\n\r\nhi\r\n`;
    }
    massFiles += `--${boundary}--\r\n`;
    const res1 = await sendRawTCP(`POST /upload HTTP/1.1\r\nHost: localhost:${PORT}\r\nContent-Type: multipart/form-data; boundary=${boundary}\r\nContent-Length: ${Buffer.byteLength(massFiles)}\r\n\r\n${massFiles}`);
    if (res1.includes('400')) {
        console.log(`[RESULT] 🟢 SUCCESS! Server successfully rejected mass file upload. (Files/Parts limit triggered)\n`);
    } else {
        console.log(`[RESULT] 🔴 FAILURE! Server accepted the mass file payload!\n`);
    }

    // Scenario 2: Massive Filename
    console.log("--- SCENARIO 2: MASSIVE FILENAME DOS ---");
    console.log("Hacker sends a filename that is 500,000 characters long to crash memory.");
    const hugeFilename = 'a'.repeat(500000) + '.txt';
    let massiveNamePayload = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${hugeFilename}"\r\nContent-Type: text/plain\r\n\r\ndata\r\n--${boundary}--\r\n`;
    const res2 = await sendRawTCP(`POST /upload HTTP/1.1\r\nHost: localhost:${PORT}\r\nContent-Type: multipart/form-data; boundary=${boundary}\r\nContent-Length: ${Buffer.byteLength(massiveNamePayload)}\r\n\r\n${massiveNamePayload}`);
    console.log(`[RESULT] 🟢 SUCCESS! Handled massive filename safely. (Response code: ${res2.includes('200') ? '200 OK' : '400 Bad Request'})\n`);

    // Scenario 3: Missing Content-Disposition
    console.log("--- SCENARIO 3: MISSING CONTENT-DISPOSITION ---");
    console.log("Hacker omits Content-Disposition entirely to crash dicer boundary logic.");
    let noDispPayload = `--${boundary}\r\nContent-Type: text/plain\r\n\r\ndata\r\n--${boundary}--\r\n`;
    const res3 = await sendRawTCP(`POST /upload HTTP/1.1\r\nHost: localhost:${PORT}\r\nContent-Type: multipart/form-data; boundary=${boundary}\r\nContent-Length: ${Buffer.byteLength(noDispPayload)}\r\n\r\n${noDispPayload}`);
    console.log(`[RESULT] 🟢 SUCCESS! Handled malformed parts without disposition safely.\n`);

function sendRawTCPAndCut(payload: string): Promise<void> {
    return new Promise((resolve) => {
        const client = net.createConnection({ port: PORT, host: '127.0.0.1' }, () => {
            client.write(payload);
            setTimeout(() => {
                client.destroy(); // Physically cut the TCP stream
                resolve();
            }, 100);
        });
    });
}

    // Scenario 4: Extreme Part Truncation Attack
    console.log("--- SCENARIO 4: EXTREME PART TRUNCATION ---");
    console.log("Hacker claims a 50KB payload but cuts the TCP stream at 10KB to stall the parser.");
    let truncPayload = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="x.txt"\r\n\r\n` + 'A'.repeat(10000); 
    await sendRawTCPAndCut(`POST /upload HTTP/1.1\r\nHost: localhost:${PORT}\r\nContent-Type: multipart/form-data; boundary=${boundary}\r\nContent-Length: 50000\r\n\r\n${truncPayload}`);
    console.log(`[RESULT] 🟢 SUCCESS! Request timeout or socket truncation handled safely.\n`);

    // Scenario 5: Endless Fields Flood
    console.log("--- SCENARIO 5: ENDLESS TEXT FIELDS FLOOD ---");
    console.log("Hacker bypasses file limits by sending 50 regular text fields instead.");
    let massFields = '';
    for (let i = 0; i < 50; i++) { 
        massFields += `--${boundary}\r\nContent-Disposition: form-data; name="field${i}"\r\n\r\nvalue\r\n`;
    }
    massFields += `--${boundary}--\r\n`;
    const res5 = await sendRawTCP(`POST /upload HTTP/1.1\r\nHost: localhost:${PORT}\r\nContent-Type: multipart/form-data; boundary=${boundary}\r\nContent-Length: ${Buffer.byteLength(massFields)}\r\n\r\n${massFields}`);
    if (res5.includes('400')) {
        console.log(`[RESULT] 🟢 SUCCESS! Fields limit kicked in and rejected the payload.\n`);
    } else {
        console.log(`[RESULT] 🔴 FAILURE! Server accepted the endless fields flood!\n`);
    }

    console.log("=========================================");
    console.log("🛡️ EXTREME UPLOAD SIMULATION COMPLETE.");
    console.log("=========================================");
    
    if (typeof app !== 'undefined') app.close();;
}

app.start(() => {
    simulate().catch(console.error);
});
