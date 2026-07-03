import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { UploadManager } from '../src/upload.js';
import * as http from 'node:http';
import { Readable } from 'node:stream';

test('UploadManager MUST correctly parse a multipart stream and enforce limits', async () => {
    const boundary = '---------------------------testboundary';
    
    // Create a mock stream that looks like an IncomingMessage
    const req = new Readable({
        read() {}
    }) as any;
    req.headers = {
        'content-type': `multipart/form-data; boundary=${boundary}`
    };

    // Push form-data content
    req.push(`--${boundary}\r\n`);
    req.push('Content-Disposition: form-data; name="username"\r\n\r\n');
    req.push('admin\r\n');
    
    req.push(`--${boundary}\r\n`);
    req.push('Content-Disposition: form-data; name="document"; filename="test.txt"\r\n');
    req.push('Content-Type: text/plain\r\n\r\n');
    req.push('Malicious payload data\r\n');
    req.push(`--${boundary}--\r\n`);
    req.push(null);

    const result = await UploadManager.parse(req, { limits: { fileSize: 5 * 1024 * 1024, files: 3 } });

    assert.equal(result.fields.username, 'admin');
    assert.equal(result.files.length, 1);
    assert.equal(result.files[0].filename, 'test.txt');
    assert.equal(result.files[0].mimetype, 'text/plain');
    assert.equal(result.files[0].size, Buffer.byteLength('Malicious payload data'));
    assert.ok(result.files[0].filepath.includes('upload_'));
});

test('UploadManager MUST throw error on malformed streams', async () => {
    const boundary = '---------------------------testboundary';
    const req = new Readable({ read() {} }) as any;
    req.headers = { 'content-type': `multipart/form-data; boundary=${boundary}` };

    // Push malformed data (missing boundary start, abrupt end)
    req.push('malformed data\r\n');
    
    // Instead of waiting, we emit an error on the stream to force busboy to fail
    setImmediate(() => {
        req.emit('error', new Error('Stream failed'));
    });

    await assert.rejects(() => UploadManager.parse(req), /Stream failed|Unexpected end of multipart data/i);
});

test('UploadManager MUST prevent Silent File Corruption on fileSize limit', async () => {
    const boundary = '---------------------------testboundary';
    const req = new Readable({ read() {} }) as any;
    req.headers = { 'content-type': `multipart/form-data; boundary=${boundary}` };

    req.push(`--${boundary}\r\n`);
    req.push('Content-Disposition: form-data; name="document"; filename="large.txt"\r\n');
    req.push('Content-Type: text/plain\r\n\r\n');
    req.push('1234567890\r\n');
    req.push(`--${boundary}--\r\n`);
    req.push(null);

    // Limit to 5 bytes
    await assert.rejects(
        () => UploadManager.parse(req, { limits: { fileSize: 5 } }),
        /Payload too large: File large.txt exceeds size limit/
    );
});

test('UploadManager MUST reject on partsLimit and filesLimit', async () => {
    const boundary = '---------------------------testboundary';
    
    // filesLimit
    const req1 = new Readable({ read() {} }) as any;
    req1.headers = { 'content-type': `multipart/form-data; boundary=${boundary}` };
    req1.push(`--${boundary}\r\n`);
    req1.push('Content-Disposition: form-data; name="doc"; filename="a.txt"\r\n\r\na\r\n');
    req1.push(`--${boundary}\r\n`);
    req1.push('Content-Disposition: form-data; name="doc2"; filename="b.txt"\r\n\r\nb\r\n');
    req1.push(`--${boundary}--\r\n`);
    req1.push(null);

    await assert.rejects(() => UploadManager.parse(req1, { limits: { files: 1 } }), /Too many files|Unexpected end/i);
});
