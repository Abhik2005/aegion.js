const Busboy = require('@fastify/busboy');
const http = require('http');

const boundary = '--------------------------1234567890';
let body = `--${boundary}\r\nContent-Disposition: form-data; name="field1"\r\n\r\nHello\r\n`;
body += `--${boundary}\r\nContent-Disposition: form-data; name="field2"\r\n\r\nWorld\r\n`;
body += `--${boundary}--\r\n`;

const req = new http.IncomingMessage();
req.headers = {
    'content-type': `multipart/form-data; boundary=${boundary}`,
    'content-length': String(Buffer.byteLength(body))
};

const bb = Busboy({ headers: req.headers, limits: { parts: 1 } });

bb.on('partsLimit', () => {
    console.log('partsLimit fired!');
});
bb.on('fieldsLimit', () => {
    console.log('fieldsLimit fired!');
});
bb.on('field', (name, val) => {
    console.log('field', name, val);
});
bb.on('finish', () => {
    console.log('finish fired!');
});

bb.write(Buffer.from(body));
bb.end();
