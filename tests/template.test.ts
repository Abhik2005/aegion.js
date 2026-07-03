import { test, describe, before, after, beforeEach } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as http from 'node:http';
import { Socket } from 'node:net';
import {
    escapeHtml,
    parse,
    compile,
    templateEngine,
    clearTemplateCache
} from '../src/template.js';
import { Context } from '../src/context.js';

// ---------------------------------------------------------------------------
// Test fixture: temporary views directory on disk
// ---------------------------------------------------------------------------
const VIEWS_DIR = path.resolve('./tests_temp_views');
const PARTIALS_DIR = path.join(VIEWS_DIR, 'partials');

function write(relPath: string, content: string) {
    const abs = path.join(VIEWS_DIR, relPath);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf-8');
}

before(() => {
    fs.mkdirSync(VIEWS_DIR, { recursive: true });
    fs.mkdirSync(PARTIALS_DIR, { recursive: true });

    write('home.html',        '<h1>{{ title }}</h1>');
    write('raw.html',         '<div>{{{ content }}}</div>');
    write('comment.html',     'before{# this is a comment #}after');
    write('if.html',          '{% if (show) { %}<span>visible</span>{% } %}');
    write('ifelse.html',      '{% if (flag) { %}<b>yes</b>{% } else { %}<i>no</i>{% } %}');
    write('loop.html',        '<ul>{% for (const item of items) { %}<li>{{ item }}</li>{% } %}</ul>');
    write('nested.html',      '{% if (items.length > 0) { %}{% for (const x of items) { %}{{ x }},{% } %}{% } else { %}empty{% } %}');
    write('helpers.html',     '{{ capitalize(name) }}');
    write('helper2.html',     '{{ truncate(bio, 5) }}');
    write('nullval.html',     '[{{ missing }}]');
    write('undefval.html',    '[{{ undef }}]');
    write('numbers.html',     '{{ count }} {{ flag }}');
    write('xss.html',         '{{ attack }}');
    write('rawxss.html',      '{{{ attack }}}');
    write('withpartial.html', '{{ include("partials/header.html") }}<main>{{ body }}</main>{{ include("partials/footer.html") }}');
    write('datapartial.html', '{{ include("partials/withdata.html") }}');
    write('nested_inc.html',  '{{ include("partials/level1.html") }}');
    write('allfeatures.html',
        '{# page template #}' +
        '{{ include("partials/header.html") }}' +
        '<h1>{{ capitalize(title) }}</h1>' +
        '{% if (items.length > 0) { %}' +
        '<ul>{% for (const item of items) { %}<li>{{ item }}</li>{% } %}</ul>' +
        '{% } else { %}<p>none</p>{% } %}' +
        '{{{ rawHtml }}}' +
        '{{ include("partials/footer.html") }}'
    );
    write('error.html',       '{{ nonExistentFunction() }}');

    write('partials/header.html', '<header>HEADER</header>');
    write('partials/footer.html', '<footer>FOOTER</footer>');
    write('partials/withdata.html', '<p>{{ user.name }}</p>');
    write('partials/level1.html', '<L1>{{ include("partials/level2.html") }}</L1>');
    write('partials/level2.html', '<L2>deep</L2>');
});

after(() => {
    fs.rmSync(VIEWS_DIR, { recursive: true, force: true });
});

beforeEach(() => {
    clearTemplateCache();
});

// ---------------------------------------------------------------------------
describe('Template Engine — HTML Escaping', () => {

    test('escapes all 6 dangerous characters', () => {
        assert.strictEqual(escapeHtml('&'),  '&amp;');
        assert.strictEqual(escapeHtml('<'),  '&lt;');
        assert.strictEqual(escapeHtml('>'),  '&gt;');
        assert.strictEqual(escapeHtml('"'),  '&quot;');
        assert.strictEqual(escapeHtml("'"),  '&#x27;');
        assert.strictEqual(escapeHtml('/'),  '&#x2F;');
    });

    test('escapes a full XSS attack string', () => {
        const xss = '<script>alert("xss")</script>';
        assert.strictEqual(
            escapeHtml(xss),
            '&lt;script&gt;alert(&quot;xss&quot;)&lt;&#x2F;script&gt;'
        );
    });

    test('converts null to empty string', () => {
        assert.strictEqual(escapeHtml(null), '');
    });

    test('converts undefined to empty string', () => {
        assert.strictEqual(escapeHtml(undefined), '');
    });

    test('converts numbers to string', () => {
        assert.strictEqual(escapeHtml(42), '42');
        assert.strictEqual(escapeHtml(3.14), '3.14');
    });

    test('converts booleans to string', () => {
        assert.strictEqual(escapeHtml(true),  'true');
        assert.strictEqual(escapeHtml(false), 'false');
    });

    test('leaves safe text untouched', () => {
        assert.strictEqual(escapeHtml('Hello World'), 'Hello World');
    });
});

// ---------------------------------------------------------------------------
describe('Template Engine — Parser', () => {

    test('generates __escape call for {{ expr }}', () => {
        const body = parse('{{ user.name }}');
        assert.ok(body.includes('__escape'));
        assert.ok(body.includes('user.name'));
    });

    test('generates String() call for {{{ expr }}}', () => {
        const body = parse('{{{ rawHtml }}}');
        assert.ok(body.includes('String('));
        assert.ok(body.includes('rawHtml'));
        assert.ok(!body.includes('__escape'));
    });

    test('generates await __include for {{ include("file") }}', () => {
        const body = parse('{{ include("partials/header.html") }}');
        assert.ok(body.includes('await __include'));
        assert.ok(body.includes('partials/header.html'));
    });

    test('emits raw code for {% code %}', () => {
        const body = parse('{% if (x > 0) { %}yes{% } %}');
        assert.ok(body.includes('if (x > 0) {'));
    });

    test('strips {# comment #} completely', () => {
        const body = parse('before{# this is a comment #}after');
        assert.ok(!body.includes('this is a comment'));
        assert.ok(body.includes('before'));
        assert.ok(body.includes('after'));
    });

    test('emits plain text via JSON.stringify', () => {
        const body = parse('<h1>Hello</h1>');
        assert.ok(body.includes('"<h1>Hello<\\/h1>"') || body.includes('"<h1>Hello</h1>"'));
    });

    test('handles empty template without crashing', () => {
        const body = parse('');
        assert.strictEqual(body, '');
    });

    test('handles template with only plain text', () => {
        const body = parse('just plain text');
        assert.ok(body.includes('just plain text'));
        assert.ok(!body.includes('__escape'));
    });
});

// ---------------------------------------------------------------------------
describe('Template Engine — Core Rendering', () => {

    test('renders {{ expr }} with escaped data', async () => {
        const engine = templateEngine(VIEWS_DIR, { cache: false });
        const html = await engine.engine!(path.join(VIEWS_DIR, 'home.html'), { title: 'Aegion' });
        assert.strictEqual(html, '<h1>Aegion</h1>');
    });

    test('renders {{{ expr }}} as raw unescaped HTML', async () => {
        const engine = templateEngine(VIEWS_DIR, { cache: false });
        const html = await engine.engine!(path.join(VIEWS_DIR, 'raw.html'), { content: '<b>bold</b>' });
        assert.strictEqual(html, '<div><b>bold</b></div>');
    });

    test('renders {# comment #} as zero output', async () => {
        const engine = templateEngine(VIEWS_DIR, { cache: false });
        const html = await engine.engine!(path.join(VIEWS_DIR, 'comment.html'), {});
        assert.strictEqual(html, 'beforeafter');
    });

    test('renders {% if %} true branch correctly', async () => {
        const engine = templateEngine(VIEWS_DIR, { cache: false });
        const html = await engine.engine!(path.join(VIEWS_DIR, 'if.html'), { show: true });
        assert.strictEqual(html, '<span>visible</span>');
    });

    test('renders {% if %} false branch — produces empty output', async () => {
        const engine = templateEngine(VIEWS_DIR, { cache: false });
        const html = await engine.engine!(path.join(VIEWS_DIR, 'if.html'), { show: false });
        assert.strictEqual(html, '');
    });

    test('renders {% if/else %} true branch', async () => {
        const engine = templateEngine(VIEWS_DIR, { cache: false });
        const html = await engine.engine!(path.join(VIEWS_DIR, 'ifelse.html'), { flag: true });
        assert.strictEqual(html, '<b>yes</b>');
    });

    test('renders {% if/else %} false branch', async () => {
        const engine = templateEngine(VIEWS_DIR, { cache: false });
        const html = await engine.engine!(path.join(VIEWS_DIR, 'ifelse.html'), { flag: false });
        assert.strictEqual(html, '<i>no</i>');
    });

    test('renders {% for %} loop over array', async () => {
        const engine = templateEngine(VIEWS_DIR, { cache: false });
        const html = await engine.engine!(path.join(VIEWS_DIR, 'loop.html'), { items: ['a', 'b', 'c'] });
        assert.strictEqual(html, '<ul><li>a</li><li>b</li><li>c</li></ul>');
    });

    test('renders nested {% for %} inside {% if %}', async () => {
        const engine = templateEngine(VIEWS_DIR, { cache: false });
        const html = await engine.engine!(path.join(VIEWS_DIR, 'nested.html'), { items: ['x', 'y'] });
        assert.strictEqual(html, 'x,y,');
    });

    test('renders nested control flow — empty array takes else branch', async () => {
        const engine = templateEngine(VIEWS_DIR, { cache: false });
        const html = await engine.engine!(path.join(VIEWS_DIR, 'nested.html'), { items: [] });
        assert.strictEqual(html, 'empty');
    });

    test('renders helpers available in template', async () => {
        const engine = templateEngine(VIEWS_DIR, {
            cache: false,
            helpers: { capitalize: (s: string) => s[0].toUpperCase() + s.slice(1) }
        });
        const html = await engine.engine!(path.join(VIEWS_DIR, 'helpers.html'), { name: 'vedad' });
        assert.strictEqual(html, 'Vedad');
    });

    test('renders helper with multiple arguments', async () => {
        const engine = templateEngine(VIEWS_DIR, {
            cache: false,
            helpers: { truncate: (s: string, n: number) => s.slice(0, n) + '...' }
        });
        const html = await engine.engine!(path.join(VIEWS_DIR, 'helper2.html'), { bio: 'Hello World' });
        assert.strictEqual(html, 'Hello...');
    });

    test('renders null/undefined values as empty string — no crash', async () => {
        const engine = templateEngine(VIEWS_DIR, { cache: false });
        const html = await engine.engine!(path.join(VIEWS_DIR, 'nullval.html'), {});
        assert.strictEqual(html, '[]');
    });

    test('renders numbers and booleans as strings', async () => {
        const engine = templateEngine(VIEWS_DIR, { cache: false });
        const html = await engine.engine!(path.join(VIEWS_DIR, 'numbers.html'), { count: 42, flag: true });
        assert.strictEqual(html, '42 true');
    });

    test('throws a meaningful error for a missing template file', async () => {
        const engine = templateEngine(VIEWS_DIR, { cache: false });
        await assert.rejects(
            () => engine.engine!(path.join(VIEWS_DIR, 'nonexistent.html'), {}),
            (err: any) => {
                assert.ok(err.message.includes('[AegionTemplate]'));
                assert.ok(err.message.includes('Template not found'));
                return true;
            }
        );
    });

    test('throws a meaningful error for runtime template error', async () => {
        const engine = templateEngine(VIEWS_DIR, { cache: false });
        await assert.rejects(
            () => engine.engine!(path.join(VIEWS_DIR, 'error.html'), {}),
            (err: any) => {
                assert.ok(err.message.includes('[AegionTemplate]'));
                assert.ok(err.message.includes('Render error'));
                return true;
            }
        );
    });
});

// ---------------------------------------------------------------------------
describe('Template Engine — Security (XSS)', () => {

    test('{{ }} auto-escapes XSS attack string', async () => {
        const engine = templateEngine(VIEWS_DIR, { cache: false });
        const html = await engine.engine!(path.join(VIEWS_DIR, 'xss.html'), {
            attack: '<script>alert("xss")</script>'
        });
        assert.ok(!html.includes('<script>'));
        assert.ok(html.includes('&lt;script&gt;'));
    });

    test('{{{ }}} does NOT escape — raw HTML passthrough', async () => {
        const engine = templateEngine(VIEWS_DIR, { cache: false });
        const html = await engine.engine!(path.join(VIEWS_DIR, 'rawxss.html'), {
            attack: '<b>intentional raw HTML</b>'
        });
        assert.strictEqual(html, '<b>intentional raw HTML</b>');
    });

    test('{{{ }}} with null renders empty string', async () => {
        const engine = templateEngine(VIEWS_DIR, { cache: false });
        const html = await engine.engine!(
            path.join(VIEWS_DIR, 'raw.html'), { content: null }
        );
        assert.strictEqual(html, '<div></div>');
    });
});

// ---------------------------------------------------------------------------
describe('Template Engine — Includes / Partials', () => {

    test('{{ include("partial") }} injects partial HTML', async () => {
        const engine = templateEngine(VIEWS_DIR, { cache: false });
        const html = await engine.engine!(path.join(VIEWS_DIR, 'withpartial.html'), { body: 'Content' });
        assert.ok(html.includes('<header>HEADER</header>'));
        assert.ok(html.includes('<main>Content</main>'));
        assert.ok(html.includes('<footer>FOOTER</footer>'));
    });

    test('partial receives same data as parent template', async () => {
        const engine = templateEngine(VIEWS_DIR, { cache: false });
        const html = await engine.engine!(path.join(VIEWS_DIR, 'datapartial.html'), {
            user: { name: 'Vedad' }
        });
        assert.strictEqual(html, '<p>Vedad</p>');
    });

    test('nested includes — include inside include — resolves recursively', async () => {
        const engine = templateEngine(VIEWS_DIR, { cache: false });
        const html = await engine.engine!(path.join(VIEWS_DIR, 'nested_inc.html'), {});
        assert.ok(html.includes('<L1>'));
        assert.ok(html.includes('<L2>deep</L2>'));
        assert.ok(html.includes('</L1>'));
    });

    test('throws security error when include escapes views directory (../)', async () => {
        write('traversal.html', '{{ include("../package.json") }}');
        const engine = templateEngine(VIEWS_DIR, { cache: false });
        await assert.rejects(
            () => engine.engine!(path.join(VIEWS_DIR, 'traversal.html'), {}),
            (err: any) => {
                assert.ok(err.message.includes('[AegionTemplate]'));
                assert.ok(err.message.includes('Security'));
                return true;
            }
        );
    });

    test('throws meaningful error when included partial does not exist', async () => {
        write('missing_partial.html', '{{ include("partials/ghost.html") }}');
        const engine = templateEngine(VIEWS_DIR, { cache: false });
        await assert.rejects(
            () => engine.engine!(path.join(VIEWS_DIR, 'missing_partial.html'), {}),
            (err: any) => {
                assert.ok(err.message.includes('[AegionTemplate]'));
                return true;
            }
        );
    });
});

// ---------------------------------------------------------------------------
describe('Template Engine — Caching', () => {

    test('cache ON: serves stale cached version after file is modified on disk', async () => {
        const cacheFile = path.join(VIEWS_DIR, 'cache_on.html');
        fs.writeFileSync(cacheFile, '<p>version 1</p>', 'utf-8');

        const engine = templateEngine(VIEWS_DIR, { cache: true });

        const first = await engine.engine!(cacheFile, {});
        assert.ok(first.includes('version 1'));

        // Modify the file on disk
        fs.writeFileSync(cacheFile, '<p>version 2</p>', 'utf-8');

        const second = await engine.engine!(cacheFile, {});
        // Cache is ON → still serves version 1 (stale)
        assert.ok(second.includes('version 1'));

        fs.rmSync(cacheFile);
    });

    test('cache OFF: re-reads file and serves fresh version after modification', async () => {
        const cacheFile = path.join(VIEWS_DIR, 'cache_off.html');
        fs.writeFileSync(cacheFile, '<p>version A</p>', 'utf-8');

        const engine = templateEngine(VIEWS_DIR, { cache: false });

        const first = await engine.engine!(cacheFile, {});
        assert.ok(first.includes('version A'));

        // Modify the file on disk
        fs.writeFileSync(cacheFile, '<p>version B</p>', 'utf-8');

        const second = await engine.engine!(cacheFile, {});
        // Cache is OFF → re-reads and serves version B
        assert.ok(second.includes('version B'));

        fs.rmSync(cacheFile);
    });

    test('NODE_ENV=production enables cache automatically', async () => {
        const savedEnv = process.env.NODE_ENV;
        process.env.NODE_ENV = 'production';

        const cacheFile = path.join(VIEWS_DIR, 'env_prod.html');
        fs.writeFileSync(cacheFile, '<p>prod v1</p>', 'utf-8');

        const engine = templateEngine(VIEWS_DIR); // no cache option — auto detect

        const first = await engine.engine!(cacheFile, {});
        assert.ok(first.includes('prod v1'));

        fs.writeFileSync(cacheFile, '<p>prod v2</p>', 'utf-8');
        const second = await engine.engine!(cacheFile, {});
        // auto-detected production → cache ON → still v1
        assert.ok(second.includes('prod v1'));

        process.env.NODE_ENV = savedEnv;
        fs.rmSync(cacheFile);
    });

    test('NODE_ENV=development disables cache automatically', async () => {
        const savedEnv = process.env.NODE_ENV;
        process.env.NODE_ENV = 'development';

        const cacheFile = path.join(VIEWS_DIR, 'env_dev.html');
        fs.writeFileSync(cacheFile, '<p>dev v1</p>', 'utf-8');

        const engine = templateEngine(VIEWS_DIR); // no cache option — auto detect

        const first = await engine.engine!(cacheFile, {});
        assert.ok(first.includes('dev v1'));

        fs.writeFileSync(cacheFile, '<p>dev v2</p>', 'utf-8');
        const second = await engine.engine!(cacheFile, {});
        // auto-detected development → cache OFF → fresh v2
        assert.ok(second.includes('dev v2'));

        process.env.NODE_ENV = savedEnv;
        fs.rmSync(cacheFile);
    });

    test('clearTemplateCache() forces recompilation on next render', async () => {
        const cacheFile = path.join(VIEWS_DIR, 'clear_test.html');
        fs.writeFileSync(cacheFile, '<p>before clear</p>', 'utf-8');

        const engine = templateEngine(VIEWS_DIR, { cache: true });

        await engine.engine!(cacheFile, {}); // populates cache

        fs.writeFileSync(cacheFile, '<p>after clear</p>', 'utf-8');
        clearTemplateCache(); // explicitly clear

        const second = await engine.engine!(cacheFile, {});
        // Cache was cleared → re-reads file → gets updated version
        assert.ok(second.includes('after clear'));

        fs.rmSync(cacheFile);
    });
});

// ---------------------------------------------------------------------------
describe('Template Engine — All Features Integration', () => {

    test('renders template combining all features correctly', async () => {
        const engine = templateEngine(VIEWS_DIR, {
            cache: false,
            helpers: { capitalize: (s: string) => s[0].toUpperCase() + s.slice(1) }
        });

        const html = await engine.engine!(path.join(VIEWS_DIR, 'allfeatures.html'), {
            title: 'welcome',
            items: ['alpha', 'beta'],
            rawHtml: '<em>raw</em>'
        });

        assert.ok(html.includes('<header>HEADER</header>'));
        assert.ok(html.includes('<h1>Welcome</h1>'));        // helper ran
        assert.ok(html.includes('<li>alpha</li>'));
        assert.ok(html.includes('<li>beta</li>'));
        assert.ok(html.includes('<em>raw</em>'));            // raw HTML unescaped
        assert.ok(html.includes('<footer>FOOTER</footer>'));
        assert.ok(!html.includes('page template'));          // comment stripped
    });
});

// ---------------------------------------------------------------------------
describe('Template Engine — Factory & ctx.render() Integration', () => {

    test('templateEngine returns ViewOptions with engine function and dir', () => {
        const view = templateEngine('./views');
        assert.strictEqual(typeof view.engine, 'function');
        assert.ok(view.dir);
    });

    test('templateEngine strips trailing slash from dir', () => {
        const view = templateEngine('./views/');
        assert.ok(!(view.dir as string).endsWith('/'));
    });

    test('ctx.render() works end-to-end with templateEngine', async () => {
        const req = new http.IncomingMessage(new Socket());
        req.url = '/';
        const res = new http.ServerResponse(req);

        let capturedHtml = '';
        (res as any).end = (chunk: any) => { capturedHtml = chunk; };
        res.setHeader = () => res;

        const ctx = new Context(req, res, undefined, {
            engine: templateEngine(VIEWS_DIR, { cache: false }).engine!,
            dir: VIEWS_DIR
        });

        await ctx.render('home.html', { title: 'Test Render' });
        assert.ok(capturedHtml.includes('<h1>Test Render</h1>'));
    });

    test('ctx.render() throws when views not configured', async () => {
        const req = new http.IncomingMessage(new Socket());
        req.url = '/';
        const res = new http.ServerResponse(req);
        const ctx = new Context(req, res);

        await assert.rejects(
            () => ctx.render('home.html', {}),
            /Template engine not configured/
        );
    });
});
