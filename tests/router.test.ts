import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { Router } from '../src/router.js';
import { get, post, group } from '../src/composition.js';

test('Router MUST match exact static paths', () => {
    const router = new Router();
    router.register(group('', get('/health', () => 'ok')));
    
    const match = router.find('GET', '/health');
    assert.ok(match);
    assert.equal(match.route.method, 'GET');
    assert.equal(match.route.path, '/health');
    assert.deepEqual(match.params, {});
});

test('Router MUST extract parameterized paths flawlessly', () => {
    const router = new Router();
    router.register(group('', get('/users/:id/posts/:postId', () => 'ok')));
    
    const match = router.find('GET', '/users/123/posts/abc');
    assert.ok(match);
    assert.equal(match.params.id, '123');
    assert.equal(match.params.postId, 'abc');
});

test('Router MUST match wildcard paths and prioritize exact matches', () => {
    const router = new Router();
    router.register(group('', 
        get('/public/*', () => 'wildcard'),
        get('/public/exact', () => 'exact')
    ));
    
    const exactMatch = router.find('GET', '/public/exact');
    assert.ok(exactMatch);
    assert.equal(exactMatch.route.path, '/public/exact');
    
    const wildcardMatch = router.find('GET', '/public/css/style.css');
    assert.ok(wildcardMatch);
    assert.equal(wildcardMatch.route.path, '/public/*');
});

test('Router MUST prevent WAF bypass by normalizing paths', () => {
    const router = new Router();
    router.register(group('', get('/admin', () => 'secret')));
    
    // Test directory traversal attempt
    const match = router.find('GET', '/public/../admin');
    assert.ok(match);
    assert.equal(match.route.path, '/admin');
    
    // Test multiple slashes
    const slashMatch = router.find('GET', '//admin');
    assert.ok(slashMatch);
});

test('Router MUST return null for unmatched routes', () => {
    const router = new Router();
    router.register(group('', get('/exists', () => 'ok')));
    
    const match = router.find('GET', '/missing');
    assert.equal(match, null);
});

test('Router MUST ignore unsupported HTTP methods', () => {
    const router = new Router();
    router.register([
        { method: 'UNKNOWN', path: '/test', middlewares: [], handler: async () => {} }
    ]);
    
    assert.equal(router.find('UNKNOWN', '/test'), null);
});
