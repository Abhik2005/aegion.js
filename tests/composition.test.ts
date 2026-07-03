import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { group, get, post } from '../src/composition.js';

test('Composition MUST recursively append prefixes to child routes', () => {
    const middleware1 = async (c: any) => c.next();
    const middleware2 = async (c: any) => c.next();

    const routes = group('/api', [middleware1],
        get('/health', async () => {}),
        group('/v1', [middleware2],
            post('/users', async () => {})
        )
    );

    assert.equal(routes.length, 2);
    
    // First route: /api/health
    assert.equal(routes[0].method, 'GET');
    assert.equal(routes[0].path, '/api/health');
    assert.equal(routes[0].middlewares.length, 1);
    assert.equal(routes[0].middlewares[0], middleware1);
    
    // Second route: /api/v1/users
    assert.equal(routes[1].method, 'POST');
    assert.equal(routes[1].path, '/api/v1/users');
    assert.equal(routes[1].middlewares.length, 2);
    assert.equal(routes[1].middlewares[0], middleware1);
    assert.equal(routes[1].middlewares[1], middleware2);
});

test('Composition MUST handle empty prefixes flawlessly', () => {
    const routes = group('', 
        get('/', async () => {})
    );

    assert.equal(routes[0].path, '/');
});

test('Composition MUST handle nested arrays of routes in group', () => {
    const routes = group('api', [
        get('/a', async () => {}),
        get('b', async () => {}) // Missing leading slash on child
    ]);
    assert.equal(routes.length, 2);
    assert.equal(routes[0].path, '/api/a');
    assert.equal(routes[1].path, '/api/b'); // Fixed by BUG-63: 'api' + 'b' correctly becomes '/api/b'
});
