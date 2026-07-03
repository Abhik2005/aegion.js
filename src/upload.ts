import Busboy from '@fastify/busboy';
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

export interface UploadedFile {
    filename: string;
    encoding: string;
    mimetype: string;
    filepath: string; // The temp path where the file is stored
    size: number;
}

export interface UploadOptions {
    limits?: {
        fileSize?: number;
        files?: number;
        fields?: number;
        fieldNameSize?: number;
        fieldSize?: number;
        parts?: number;
    }
}

export class UploadManager {
    static async parse(req: http.IncomingMessage, options: UploadOptions = {}): Promise<{ fields: Record<string, string>, files: UploadedFile[] }> {
        return new Promise((resolve, reject) => {
            const busboy = new (Busboy as any)({
                headers: req.headers,
                limits: {
                    fileSize: options.limits?.fileSize ?? 10 * 1024 * 1024,
                    files: options.limits?.files ?? 5,
                    fields: options.limits?.fields ?? 50,
                    fieldNameSize: options.limits?.fieldNameSize ?? 100,
                    fieldSize: options.limits?.fieldSize ?? 1024 * 1024,
                    parts: options.limits?.parts ?? ((options.limits?.files ?? 5) + (options.limits?.fields ?? 50))
                }
            });

            const fields: Record<string, string> = {};
            const files: UploadedFile[] = [];
            const tempDir = os.tmpdir();

            busboy.on('field', (name: string, val: any, nameTruncated: boolean, valTruncated: boolean) => {
                /* c8 ignore next 6 */
                if (nameTruncated || valTruncated || name.length > 100) {
                    req.unpipe(busboy);
                    req.resume();
                    reject(new Error('Payload too large: Field name or value exceeds limit.'));
                    return;
                }
                fields[name] = val;
            });

            busboy.on('partsLimit', () => {
                req.unpipe(busboy);
                req.resume();
                reject(new Error('Too many parts'));
            });
            busboy.on('filesLimit', () => {
                req.unpipe(busboy);
                req.resume();
                reject(new Error('Too many files'));
            });
            /* c8 ignore next 5 */
            busboy.on('fieldsLimit', () => {
                req.unpipe(busboy);
                req.resume();
                reject(new Error('Too many fields'));
            });

            busboy.on('file', (fieldname: string, file: NodeJS.ReadableStream, filename: string, encoding: string, mimetype: string) => {
                // Prevent OS extension bypasses (trailing dots/spaces) and null byte injections
                /* c8 ignore next */
                const safeFilename = filename ? filename.replace(/[\x00-\x1F]/g, '').trim().replace(/\.+$/, '') : 'unknown';
                
                const tempPath = path.join(tempDir, `upload_${Date.now()}_${Math.random().toString(36).substring(2)}`);
                const writeStream = fs.createWriteStream(tempPath);
                
                let size = 0;
                let isTruncated = false;
                
                file.on('data', (data: Buffer) => {
                    size += data.length;
                });

                file.on('limit', () => {
                    isTruncated = true;
                    // BUG-66 FIX: Drain the stream to prevent resource exhaustion
                    req.unpipe(busboy);
                    req.resume();
                    fs.promises.unlink(tempPath).catch(() => {});
                    reject(new Error(`Payload too large: File ${filename} exceeds size limit.`));
                });

                file.pipe(writeStream);

                file.on('end', () => {
                    /* c8 ignore next */
                    if (isTruncated) return;
                    files.push({
                        filename: safeFilename,
                        encoding,
                        mimetype,
                        filepath: tempPath,
                        size
                    });
                });
            });

            busboy.on('finish', () => {
                resolve({ fields, files });
            });

            busboy.on('error', (err: any) => {
                /* c8 ignore next 2 */
                reject(err);
            });

            req.on('error', (err: any) => {
                reject(err);
            });

            req.pipe(busboy);
        });
    }
}
