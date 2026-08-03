# Changelog

All notable changes to **aegion.js** are documented in this file.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).
Versioning follows [Semantic Versioning](https://semver.org/).

---

## [2.0.0] — 2026-08-03

> **This is a major release.** Breaking changes are listed at the top.

### Added

- **`autoload()` recursive directory scanning** — `Server.autoload()` now recursively walks the entire directory tree at any depth to discover `routes.ts` / `routes.js` files. Previously only scanned one level of subdirectories.

- **`ContextOptions` options-bag constructor** — `Context` now accepts a clean named-options object `{ secretKey, views, session, nosqlSanitizer }` as an alternative to the original 6-positional-argument signature. Both forms remain fully supported.

- **Configurable session cookie names** — `SessionConfig` now accepts `accessTokenName` and `refreshTokenName` overrides. Prevents cookie collision when running multiple aegion.js apps on the same domain. Defaults remain `aegion_access` / `aegion_refresh`.

- **`csp()` middleware exported from public API** — The Content Security Policy middleware was fully implemented but never exported. It is now accessible via `import { csp } from 'aegion.js'` along with its `CspOptions` and `CspDirectives` types.

- **NoSQL dot-notation injection protection** — `Sanitizer.sanitizeNoSQL()` now also blocks keys containing `.` (dot-notation field path traversal), in addition to the existing `$` operator prefix check. Dot-notation keys like `"user.isAdmin"` allow privilege escalation via MongoDB `$set` operations.

- **Structural type guards in `group()`** — Replaced the fragile `typeof arg[0] === 'function'` duck-type detection with explicit `isRouteDefinition()` and `isMiddleware()` structural guards. Fixes silent misclassification of empty arrays and nested route groups.

- **HTTPS and HTTP/2 support** — `Server` now automatically picks the correct engine based on configuration. `http2: true` + TLS → HTTP/2 with TLS (h2), `http2: true` alone → cleartext h2c, TLS only → HTTPS/1.1, neither → plain HTTP/1.1. Certificates are resolved automatically from file paths — no manual `fs.readFileSync()` needed. Falls back to `TLS_KEY_PATH` / `TLS_CERT_PATH` env variables if `options.tls` is not set in the constructor. New `TlsOptions` interface exported from public API.

- **Production Benchmark Suite** — New `benchmarks/` directory with `server.ts` (production-grade server configuration) and `run.ts` (orchestrator using `autocannon`). Run via `npm run benchmark`.

- **Positive-integer validation for JWT session expiry** — `SessionManager` now throws a clear `Error` if `accessExpiresIn` or `refreshExpiresIn` are not positive integers (`> 0`), catching misconfigurations at construction time instead of silently issuing broken tokens.

### Fixed

- **`handleRequest` indentation** — The entire body of the `try` block in `Server.handleRequest()` was indented at the same level as the `try` keyword itself (8 spaces) instead of being correctly nested (12 spaces). All statements are now uniformly indented.

- **`autoload()` now uses async I/O** — Replaced two synchronous `fs.readdirSync()` calls inside the `async autoload()` method with `fs.promises.readdir()`, preventing event-loop blocking during server startup.

### Breaking Changes

- **`CONTINUE_PIPELINE` removed from public API** — This internal sentinel `Symbol` used by `Pipeline.execute()` to detect `ctx.next()` calls was exported unnecessarily. End users use `ctx.next()` directly and have no need for the raw symbol. **Migration:** Replace any `import { CONTINUE_PIPELINE } from 'aegion'` with `return ctx.next()`.

- **`executionContext` no longer exported** — `AsyncLocalStorage` instance in `pipeline.ts` is now module-private. It was an internal request-binding slot with no valid external use case. **Migration:** Remove any direct import of `executionContext`.

- **`RateLimitOptions.max` renamed to `maxRequests`** — The `max` field has been renamed to `maxRequests` for clarity and to avoid collision with built-in JS `Math.max`. **Migration:** Replace `rateLimit: { max: N }` with `rateLimit: { maxRequests: N }` in your `ServerOptions`.

### Changed

### Security

- **NoSQL dot-notation field path traversal blocked** — Attackers sending `{ "user.isAdmin": true }` in a request body could escalate privileges via MongoDB `$set` operations. The sanitizer now rejects any key containing a `.`.

---

## [1.0.0] — Initial Release

### Added

- **Radix Tree Router** — `O(k)` URL matching immune to ReDoS. Supports static routes, parameterized segments (`:id`), and wildcard catch-alls (`*`). Priority order: static > param > wildcard.
- **Functional Composition routing** — Pure functional `get()`, `post()`, `put()`, `patch()`, `del()`, `options()`, `head()`, and `group()` helpers that return plain `RouteDefinition` arrays.
- **Fail-Closed middleware pipeline** — Middleware that neither calls `ctx.next()` nor sends a response causes an automatic `500` abort, preventing accidental authorization bypass.
- **Body parser** — Lazy `await ctx.body()` with strict 1MB limit, prototype-poisoning defense (`__proto__` / `constructor` key destruction), JSON precision-loss attack detection, and request-level caching to prevent double-stream reads.
- **Zod schema validation** — `ctx.body({ field: schema.string() })` compiles and validates the request body against a Zod schema, returning a structured `400` on failure.
- **CORS middleware** — Strict origin checking, credentials support, preflight bypass (instant `204` without hitting the router), configurable `Max-Age` and allowed headers.
- **Security headers** — Automatic injection of `X-Content-Type-Options: nosniff`, `Strict-Transport-Security`, and `X-Frame-Options: DENY` on every response.
- **Rate limiter** — In-memory sliding-window rate limiting with OOM defense (`maxKeys` cap), DDoS-safe cleanup (blocks new IPs instead of evicting tracked ones), and `trustProxy` support using the last IP in `X-Forwarded-For`.
- **JWT engine** — Native `crypto` HMAC-SHA256 implementation. Enforces minimum 32-byte key (RFC 7518), mandatory `exp` claim, timing-safe signature comparison, and expiry enforcement.
- **Stateless dual-token sessions** — Automatic `Access + Refresh` cookie issuance, zero-DB-lookup verification, seamless rotation on expiry, and `destroy()` for instant logout.
- **CSRF protection** — Double Submit Cookie (stateless) and Synchronizer Token (stateful/Redis) patterns. XOR-masked tokens for BREACH defense. Timing-safe comparison.
- **Content Security Policy (`csp`)** — Per-request cryptographic nonce injection, full CSP directive builder, and `report-only` mode support.
- **Brute-force / account lockout** — Per-identifier failure tracking with fixed lockout window, pluggable Redis adapter, and OOM-safe memory cap.
- **Password hashing (`Hash`)** — Peppered scrypt architecture: HMAC-SHA256 pepper lock → per-user random salt → scrypt KDF. Versioned pepper map for zero-downtime pepper rotation.
- **Encrypted cookies** — AES-GCM encrypted cookie values via `ctx.cookie.setEncrypted()` / `ctx.cookie.getEncrypted()`.
- **Multipart file uploads** — `await ctx.upload()` powered by `@fastify/busboy` with configurable `fileSize` and `files` limits.
- **Static file server** — `serveStatic()` with ETag / `304 Not Modified` support, directory traversal defense, dotfile protection (`deny` / `ignore` / `allow`), and directory listing refusal.
- **SSR template engine** — Agnostic `ctx.render(template, data)` helper that delegates to any configured view engine (EJS, Handlebars, React SSR, etc.).
- **Environment parser** — `EnvParser.parse(zodSchema)` validates `.env` files at startup and returns a deeply frozen object. `process.env` always wins over `.env` file values (Docker/Kubernetes convention).
- **NoSQL injection sanitizer** — Recursive scan of request body, query params, and route params for `$`-prefixed MongoDB operator keys.
- **Stream response** — `ctx.stream(readable, mimeType, size)` pipes a Node.js `Readable` directly to the HTTP response with `Content-Length` for browser progress bars.
- **Autoload (flat)** — `Server.autoload(dirPath)` scanned one level of subdirectories for `routes.ts` / `routes.js` files and registered them automatically.
- **Full TypeScript typings** — All public classes, interfaces, and function signatures are strictly typed and exported.
