import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Server } from '../src/server.js';

test('Autoload - Case 1: Deep recursive route discovery across multiple hierarchy levels', async () => {
    const srv = new Server();
    const testDir = path.resolve(process.cwd(), 'tests_temp_autoload_case1');
    
    try {
        // Level 0 (Root of test dir)
        fs.mkdirSync(testDir, { recursive: true });
        fs.writeFileSync(path.join(testDir, 'routes.ts'), `
            export default [ { method: 'GET', path: '/root', middlewares: [], handler: async () => {} } ];
        `);

        // Level 1
        const level1 = path.join(testDir, 'api');
        fs.mkdirSync(level1, { recursive: true });
        fs.writeFileSync(path.join(level1, 'routes.ts'), `
            export default [ { method: 'GET', path: '/api', middlewares: [], handler: async () => {} } ];
        `);

        // Level 2
        const level2 = path.join(level1, 'v1');
        fs.mkdirSync(level2, { recursive: true });
        fs.writeFileSync(path.join(level2, 'routes.ts'), `
            export default [ { method: 'POST', path: '/api/v1', middlewares: [], handler: async () => {} } ];
        `);

        // Level 4 (Deeply nested)
        const level4 = path.join(level2, 'users', 'profile');
        fs.mkdirSync(level4, { recursive: true });
        fs.writeFileSync(path.join(level4, 'routes.ts'), `
            export default [ { method: 'DELETE', path: '/api/v1/users/profile', middlewares: [], handler: async () => {} } ];
        `);

        await srv.autoload('tests_temp_autoload_case1');
        
        const router = (srv as any).router;
        assert.ok(router.find('GET', '/root'), 'Must discover root-level routes.ts');
        assert.ok(router.find('GET', '/api'), 'Must discover Level 1 routes.ts');
        assert.ok(router.find('POST', '/api/v1'), 'Must discover Level 2 routes.ts');
        assert.ok(router.find('DELETE', '/api/v1/users/profile'), 'Must discover Level 4 deeply nested routes.ts');
    } finally {
        if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
    }
});

test('Autoload - Case 2: Multi-file extension support (routes.ts and routes.js)', async () => {
    const srv = new Server();
    const testDir = path.resolve(process.cwd(), 'tests_temp_autoload_case2');

    try {
        const tsDir = path.join(testDir, 'mod_ts');
        const jsDir = path.join(testDir, 'mod_js');
        fs.mkdirSync(tsDir, { recursive: true });
        fs.mkdirSync(jsDir, { recursive: true });

        fs.writeFileSync(path.join(tsDir, 'routes.ts'), `
            export default [ { method: 'GET', path: '/from_ts', middlewares: [], handler: async () => {} } ];
        `);
        fs.writeFileSync(path.join(jsDir, 'routes.js'), `
            export default [ { method: 'GET', path: '/from_js', middlewares: [], handler: async () => {} } ];
        `);

        await srv.autoload('tests_temp_autoload_case2');
        
        const router = (srv as any).router;
        assert.ok(router.find('GET', '/from_ts'), 'Must autoload routes.ts file');
        assert.ok(router.find('GET', '/from_js'), 'Must autoload routes.js file');
    } finally {
        if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
    }
});

test('Autoload - Case 3: Gracefully handle non-existent directory without crashing', async () => {
    const srv = new Server();
    // Should print warning but resolve cleanly without throwing
    await assert.doesNotReject(async () => {
        await srv.autoload('non_existent_random_directory_987654321');
    });
});

test('Autoload - Case 4: Ignore auxiliary files, helpers, schemas, and non-route extensions', async () => {
    const srv = new Server();
    const testDir = path.resolve(process.cwd(), 'tests_temp_autoload_case4');

    try {
        fs.mkdirSync(testDir, { recursive: true });
        
        // Auxiliary files that shouldn't be loaded or registered as routes
        fs.writeFileSync(path.join(testDir, 'helper.ts'), `export const something = 123;`);
        fs.writeFileSync(path.join(testDir, 'schema.js'), `export const schema = {};`);
        fs.writeFileSync(path.join(testDir, 'routes.css'), `body { color: red; }`);
        fs.writeFileSync(path.join(testDir, 'not_routes.ts'), `
            export default [ { method: 'GET', path: '/should_not_load', middlewares: [], handler: async () => {} } ];
        `);
        
        // Valid route file
        fs.writeFileSync(path.join(testDir, 'routes.ts'), `
            export default [ { method: 'GET', path: '/valid_route', middlewares: [], handler: async () => {} } ];
        `);

        await srv.autoload('tests_temp_autoload_case4');

        const router = (srv as any).router;
        assert.ok(router.find('GET', '/valid_route'), 'Must load routes.ts');
        assert.strictEqual(router.find('GET', '/should_not_load'), null, 'Must NOT load files named not_routes.ts');
    } finally {
        if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
    }
});

test('Autoload - Case 5: Gracefully ignore files with invalid or missing default exports', async () => {
    const srv = new Server();
    const testDir = path.resolve(process.cwd(), 'tests_temp_autoload_case5');

    try {
        const dir1 = path.join(testDir, 'no_default');
        const dir2 = path.join(testDir, 'non_array_default');
        const dir3 = path.join(testDir, 'null_default');
        const dir4 = path.join(testDir, 'valid');
        
        fs.mkdirSync(dir1, { recursive: true });
        fs.mkdirSync(dir2, { recursive: true });
        fs.mkdirSync(dir3, { recursive: true });
        fs.mkdirSync(dir4, { recursive: true });

        fs.writeFileSync(path.join(dir1, 'routes.ts'), `export const routes = [];`);
        fs.writeFileSync(path.join(dir2, 'routes.ts'), `export default { method: 'GET' };`);
        fs.writeFileSync(path.join(dir3, 'routes.ts'), `export default null;`);
        fs.writeFileSync(path.join(dir4, 'routes.ts'), `
            export default [ { method: 'GET', path: '/survivor', middlewares: [], handler: async () => {} } ];
        `);

        // Must not throw or crash on invalid exports
        await srv.autoload('tests_temp_autoload_case5');
        
        const router = (srv as any).router;
        assert.ok(router.find('GET', '/survivor'), 'Valid route should survive despite adjacent invalid exports');
    } finally {
        if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
    }
});

test('Autoload - Case 6: Traverse deeply nested directory structures with empty intermediate folders', async () => {
    const srv = new Server();
    const testDir = path.resolve(process.cwd(), 'tests_temp_autoload_case6');

    try {
        // Create 5 levels of empty directories leading down to the actual route file
        const deepLeaf = path.join(testDir, 'alpha', 'beta', 'gamma', 'delta', 'epsilon');
        fs.mkdirSync(deepLeaf, { recursive: true });
        
        fs.writeFileSync(path.join(deepLeaf, 'routes.ts'), `
            export default [ { method: 'GET', path: '/deep_leaf', middlewares: [], handler: async () => {} } ];
        `);

        await srv.autoload('tests_temp_autoload_case6');

        const router = (srv as any).router;
        assert.ok(router.find('GET', '/deep_leaf'), 'Must traverse through intermediate empty directories to find leaf routes.ts');
    } finally {
        if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
    }
});
