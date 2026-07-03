# Aegion - Enterprise Node.js Web Framework

Aegion is a blazingly fast, hyper-secure, zero-dependency Node.js web framework designed for enterprise scale. 

Unlike Express or Fastify, Aegion was built with a "Security-First, Fail-Closed" architecture. It combines the raw performance of an O(1) Radix Tree router with built-in defenses against OOM (Out-of-Memory) attacks, Brute Force attacks, CSRF, and XSS.

All modules are exported from the root `aegion` package, ensuring a clean and centralized developer experience.

---

## 📖 Table of Contents
1. [Installation & Server Booting](#1-installation--server-booting)
2. [Declarative Routing (O(1) Radix Tree)](#2-declarative-routing-o1-radix-tree)
3. [The Context (`ctx`) & Built-in Managers](#3-the-context-ctx--built-in-managers)
4. [The Pipeline & Middlewares](#4-the-pipeline--middlewares)
5. [Body Parsing & Zod Validation](#5-body-parsing--zod-validation)
6. [File Uploads (`ctx.upload`)](#6-file-uploads-ctxupload)
7. [Cookies & Session Management](#7-cookies--session-management)
8. [Security: Brute Force & Rate Limiting](#8-security-brute-force--rate-limiting)
9. [Security: CSP, CSRF, & Headers](#9-security-csp-csrf--headers)
10. [Stateless JWT Authentication](#10-stateless-jwt-authentication)
11. [Template Engine & Native Streaming](#11-template-engine--native-streaming)
12. [Static File Server](#12-static-file-server)
13. [The Hash Module (Peppered Scrypt)](#13-the-hash-module-peppered-scrypt)

---

## 1. Installation & Server Booting

Aegion uses a highly structured configuration object. It automatically parses and freezes environment variables to prevent tampering at runtime.

### Basic Setup
```typescript
import { Server } from 'aegion';

const app = new Server({
    port: 3000,
    cookieSecret: 'super-secret-32-byte-encryption-key!', // Required for signed cookies and sessions
    nosqlSanitizer: true, // Automatically strips $ operators from JSON to prevent NoSQL injection
});

app.start(() => {
    console.log('Server is live on http://localhost:3000');
});
```

### Advanced Setup with Global Error Handling
Aegion operates on a "Fail-Closed" philosophy. If a route throws an error, the server won't crash. It routes the error directly to your global `errorHandler`.

```typescript
const app = new Server({
    port: 3000,
    errorHandler: (err, ctx) => {
        console.error('[CRITICAL BUG]:', err);
        
        // Prevent stack trace leakage in production
        const message = process.env.NODE_ENV === 'production' 
            ? 'Internal Server Error' 
            : err.message;

        ctx.status(500).json({ error: message });
    }
});
```

---

## 2. Declarative Routing (O(1) Radix Tree)

Aegion does not use `app.get()` or `app.use()`. Instead, you build your API visually using a Declarative Functional API (`group`, `get`, `post`, `del`, etc.).

Under the hood, Aegion compiles these arrays into a **Radix Tree (Trie)**. This means route matching happens in `O(1)` or `O(log N)` time. 

### Basic Routes & Parameters
```typescript
import { get, post, del, group } from 'aegion';

const apiRoutes = group('/api/v1',
    // 1. Static Exact Match
    get('/health', (ctx) => ctx.json({ status: 'ok' })),
    
    // 2. Dynamic Parameters
    get('/users/:id', (ctx) => {
        // Access URL parameters via ctx.params
        ctx.json({ userId: ctx.params.id });
    }),

    // 3. Complex Nested Parameters
    get('/users/:userId/posts/:postId', (ctx) => {
        ctx.json({ 
            user: ctx.params.userId, 
            post: ctx.params.postId 
        });
    }),
    
    // 4. RESTful actions
    post('/users', (ctx) => ctx.status(201).json({ created: true })),
    del('/users/:id', (ctx) => ctx.status(204).json()),

    // 5. Catch-All Wildcards (Great for 404s or SPAs)
    get('/assets/*', (ctx) => ctx.html('<h1>Asset Page</h1>'))
);

// Mount the compiled tree to the server
app.register(apiRoutes);
```

---

## 3. The Context (`ctx`) & Built-in Managers

The `Context` object encapsulates the raw Node.js `req` and `res` objects. It abstracts away boilerplate and attaches built-in security managers directly to the request scope.

### Core Properties
* **`ctx.req` / `ctx.res`**: Raw Node.js incoming and outgoing streams.
* **`ctx.params`**: Contains URL parameters (e.g., `:id`).
* **`ctx.query`**: Parsed query string (e.g., `?search=true` -> `{ search: 'true' }`).
* **`ctx.locals`**: An empty object to pass data (like user profiles) down the middleware pipeline.
* **`ctx.cookie`**: The `CookieManager` (handles parsing and signing).
* **`ctx.session`**: The `SessionManager` (handles encrypted state).

### Chainable Methods
```typescript
import { get } from 'aegion';

app.register([
    get('/example', (ctx) => {
        // Chain status codes directly to response methods
        return ctx.status(404).json({ error: 'Not Found' });
    }),
    
    get('/html', (ctx) => {
        return ctx.status(200).html('<h1>Hello World</h1>');
    })
]);
```

---

## 4. The Pipeline & Middlewares

Middlewares are just functions that receive `ctx`. 
**Crucial Detail:** Middlewares must return `ctx.next()` (or `CONTINUE_PIPELINE`) to yield control. If they don't return it, Aegion halts the pipeline immediately to prevent accidental data leakage.

### Creating an Authentication Middleware
```typescript
import { group, get } from 'aegion';

const requireAuth = async (ctx) => {
    const token = ctx.req.headers['authorization'];
    
    if (!token || token !== 'Bearer secret123') {
        // Halting the pipeline: We respond and DO NOT call ctx.next()
        return ctx.status(401).json({ error: 'Unauthorized' });
    }

    // Attach data for the next handler to use
    ctx.locals.user = { id: 1, role: 'admin' };
    
    // Success: Signal Aegion to continue down the tree
    return ctx.next(); 
};

// Applying the middleware to a protected route group
app.register(
    group('/dashboard', 
        [requireAuth], // Array of middlewares executing sequentially
        get('/stats', (ctx) => {
            // This handler only executes if requireAuth returned ctx.next()
            ctx.json({ adminStats: true, user: ctx.locals.user });
        })
    )
);
```

---

## 5. Body Parsing & Zod Validation

Aegion defends against Out-Of-Memory (OOM) attacks by instantly aborting JSON payloads larger than 1MB. Even better, you can pass a `Zod` schema directly into `ctx.body()` for native, automatic type validation!

### Simple Body Parsing
```typescript
import { post } from 'aegion';

app.register([
    post('/simple', async (ctx) => {
        const body = await ctx.body(); // Safely parses JSON up to 1MB
        ctx.json({ received: body });
    })
]);
```

### Strict Zod Validation (Highly Recommended)
```typescript
import { post } from 'aegion';
import { z } from 'zod';

const userSchema = z.object({
    username: z.string().min(3).max(20),
    age: z.number().int().positive(),
    preferences: z.object({
        darkMode: z.boolean()
    })
});

app.register([
    post('/users', async (ctx) => {
        try {
            // Parses the body AND validates it against Zod instantly.
            // Automatically drops unrecognized fields and stops NoSQL injections.
            const body = await ctx.body(userSchema); 
            
            ctx.status(201).json({ created: body.username });
        } catch (err) {
            // Throws structured Zod validation errors to the client
            ctx.status(400).json({ error: 'Validation Failed', details: err.errors });
        }
    })
]);
```

---

## 6. File Uploads (`ctx.upload`)

File uploads stream data directly to physical disk. The RAM usage stays perfectly flat at ~0MB, even if 10,000 users upload 50MB 4K videos simultaneously. 

### Secure Upload Endpoint
```typescript
import { post } from 'aegion';
import * as os from 'node:os';

app.register([
    post('/upload/avatar', async (ctx) => {
        try {
            // ctx.upload is a native wrapper protecting the event loop
            const { fields, files } = await ctx.upload({
                tempDir: os.tmpdir(),
                limits: {
                    fileSize: 2 * 1024 * 1024, // Hard limit: 2MB per file
                    files: 1,                  // Hard limit: 1 file per request
                    parts: 3                   // Hard limit: 3 fields max
                }
            });

            if (files.length === 0) {
                return ctx.status(400).json({ error: 'No file uploaded' });
            }

            // files[0].filepath contains the safe, temporary disk path.
            // Move it to AWS S3 or your permanent storage here.
            ctx.json({ 
                success: true, 
                fileName: files[0].filename,
                path: files[0].filepath 
            });
            
        } catch (err) {
            // Catches "Payload Too Large" if the user violates limits
            ctx.status(413).json({ error: err.message });
        }
    })
]);
```

---

## 7. Cookies & Session Management

`CookieManager` and `SessionManager` are instantly available on `ctx`.

### Standard & Signed Cookies
```typescript
import { get } from 'aegion';

app.register([
    get('/set-cookies', (ctx) => {
        // Standard Cookie
        ctx.cookie.set('theme', 'dark', { 
            httpOnly: false, 
            maxAge: 86400 // 1 day 
        });

        // Cryptographically Signed Cookie (Tamper-proof)
        // Requires cookieSecret in ServerOptions
        ctx.cookie.setSigned('role', 'admin', { 
            httpOnly: true, 
            secure: true // Only over HTTPS
        });

        ctx.json({ success: true });
    }),

    get('/get-cookies', (ctx) => {
        const theme = ctx.cookie.get('theme');
        const role = ctx.cookie.getSigned('role'); // Returns null if the user modified it
        
        ctx.json({ theme, role });
    })
]);
```

### Encrypted Sessions
```typescript
app.register([
    get('/cart/add', (ctx) => {
        // Automatically handles encryption and cookie headers
        ctx.session.set('cart_items', ['item_1']);
        ctx.json({ success: true });
    }),

    get('/cart/view', (ctx) => {
        const items = ctx.session.get('cart_items') || [];
        ctx.json({ items });
    })
]);
```

---

## 8. Security: Brute Force & Rate Limiting

### Rate Limiting (DDoS Protection)
Configured on the Server instance to drop spam connections globally using an in-memory Sliding Window.

```typescript
const app = new Server({
    port: 3000,
    rateLimit: {
        windowMs: 15 * 60 * 1000, // 15-minute window
        max: 500, // Max 500 requests per IP
        message: 'Rate limit exceeded. Too much traffic.'
    }
});
```

### Brute Force Protection (Anti-Bot)
Uses an **Exponential Backoff Algorithm**. If a bot tries to guess a password, the first failure locks them out for 1 second. The next failure locks them out for 2 seconds, then 4, 8, 16, etc.

```typescript
import { bruteForce, post } from 'aegion';

const loginDefense = bruteForce({
    windowMs: 60 * 1000 * 60, // Track IPs for 1 hour
    maxFailures: 3,           // Allow 3 initial mistakes before penalty
    delayMs: 1000             // Starting penalty delay (doubles recursively)
});

app.register([
    post('/login', [loginDefense], async (ctx) => {
        const { username, password } = await ctx.body();
        
        const isValid = (username === 'admin' && password === 'password123');
        
        if (!isValid) {
            // 🚨 CRITICAL: You must call recordFailure() to trigger the backoff penalty!
            ctx.locals.recordFailure(); 
            return ctx.status(401).json({ error: 'Invalid credentials' });
        }
        
        ctx.json({ success: true, token: 'xxx' });
    })
]);
```

---

## 9. Security: CSP, CSRF, & Headers

### Content Security Policy (CSP) & Nonces
CSP prevents Cross-Site Scripting (XSS). Aegion auto-generates a cryptographic `nonce` on every single request.

```typescript
import { csp, get } from 'aegion';

const cspSecurity = csp({
    useNonce: true, 
    directives: { 
        defaultSrc: ["'self'"],
        imgSrc: ["'self'", "https://cdn.example.com"],
        scriptSrc: ["'self'"] // Nonce is auto-injected into allowed scripts
    }
});

app.register([
    get('/profile', [cspSecurity], (ctx) => {
        const nonce = ctx.locals.nonce; 
        // This script will execute because it possesses the server's unique nonce.
        // A hacker's injected <script> tag will be blocked by the browser.
        ctx.html(`<script nonce="${nonce}">console.log('Secure execution!')</script>`);
    })
]);
```

### CSRF Protection (Double Submit Cookie)
Prevents malicious websites from making API requests.

```typescript
import { csrf, get, post } from 'aegion';

const csrfSecurity = csrf({ cookieName: '_csrf', headerName: 'x-csrf-token' });

app.register([
    // 1. Send the token to the frontend (GET)
    get('/form', [csrfSecurity], (ctx) => {
        ctx.html(`
            <form id="myForm">
                <input type="hidden" id="csrf" value="${ctx.locals.csrfToken}">
                <button type="submit">Send</button>
            </form>
        `);
    }),
    
    // 2. Validate the token (POST)
    // Aegion automatically rejects this request with 403 Forbidden
    // if the token in the header doesn't match the token in the cookie!
    post('/submit', [csrfSecurity], (ctx) => ctx.json({ success: true }))
]);
```

---

## 10. Stateless JWT Authentication

Aegion provides a lightning-fast native implementation for signing and verifying JSON Web Tokens (JWT) using `crypto` HMAC-SHA256. 

### Signing & Verifying Tokens
```typescript
import { JWT, get } from 'aegion';

app.register([
    // Issuing the token
    get('/api/login', (ctx) => {
        const payload = { userId: 42, role: 'editor' };
        
        // Generates an encrypted token string that expires in 2 hours
        const token = JWT.sign(payload, ctx.env.COOKIE_SECRET, { expiresIn: '2h' });
        
        ctx.json({ token });
    }),

    // Verifying the token
    get('/api/protected', (ctx) => {
        const authHeader = ctx.req.headers['authorization'];
        
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return ctx.status(401).json({ error: 'Missing token' });
        }

        const token = authHeader.split(' ')[1];

        try {
            // Validates signature and expiration date
            const payload = JWT.verify(token, ctx.env.COOKIE_SECRET);
            ctx.json({ valid: true, user: payload });
        } catch (err) {
            ctx.status(401).json({ error: 'Token forged or expired' });
        }
    })
]);
```

---

## 11. Template Engine & Native Streaming

Aegion includes a native templating engine designed for speed and security. It caches compiled templates in RAM and automatically escapes HTML to prevent Injection.

### Configuring the Engine
```typescript
import { templateEngine } from 'aegion';

const app = new Server({
    port: 3000,
    views: {
        engine: templateEngine({ 
            dir: './views', 
            cache: process.env.NODE_ENV === 'production' 
        })
    }
});
```

### Template Syntax
**`views/dashboard.html`**
```html
<!-- Variables (Auto-escaped to stop <script> tags) -->
<h1>Welcome {{ user.firstName }}</h1>

<!-- Unescaped Output (Use only if you trust the source!) -->
<div>{{{ trustedHTML }}}</div>

<!-- If/Else Logic -->
{% if user.isAdmin %}
    <a href="/admin">Admin Panel</a>
{% else %}
    <p>Standard Access</p>
{% endif %}

<!-- Iterators / Loops -->
<ul>
    {% for item of inventory %}
        <li>{{ item.name }} - ${{ item.price }}</li>
    {% endfor %}
</ul>

<!-- File Inclusions (Great for components) -->
{{ include("partials/footer.html") }}
```

### High-Performance Native Streaming
Use `ctx.stream()` to bypass the synchronous pipeline and pipe files directly to the network socket using C++ buffers.

```typescript
import { get } from 'aegion';
import * as fs from 'node:fs';

app.register([
    get('/video', (ctx) => {
        const stat = fs.statSync('./movie.mp4');
        const readStream = fs.createReadStream('./movie.mp4');
        
        // Native streaming with Content-Length headers for seeking
        return ctx.stream(readStream, 'video/mp4', stat.size);
    })
]);
```

---

## 12. Static File Server

The static file server efficiently streams CSS, Images, and JS files to the browser. It features built-in path-traversal protection (blocking `../../../etc/passwd` attacks) and refuses to serve hidden dotfiles (like `.env` or `.git`).

```typescript
import { serveStatic, group } from 'aegion';

// Serve everything in the 'public' folder under the '/static' route prefix
const staticRoutes = serveStatic('/static', './public', {
    maxAge: 86400, // Tells browsers to cache assets for 1 day
    dotfiles: 'ignore', // Sends 404 if someone requests '/static/.env'
    index: 'index.html' // Automatically serves index.html on root path
});

// You can serve multiple directories!
const uploadRoutes = serveStatic('/uploads', './user_uploads');

app.register(staticRoutes);
app.register(uploadRoutes);
```

---

## 13. The Hash Module (Peppered Scrypt)

Aegion ships with a native, zero-dependency password hashing module that mathematically defeats both GPU farms and CPU cache-timing attacks. It utilizes **Scrypt**, wrapped in an **HMAC-SHA256 Pepper**, and enforces strict string memory limits to prevent DoS attacks.

### Key Rotation & Versioning
Aegion seamlessly handles key rotation by allowing you to pass a `pepperMap`. If you ever need to change your master key, Aegion will transparently upgrade users to the newest version the next time they log in, with zero downtime.

### Hashing a Password
```typescript
import { Hash } from 'aegion';

// 1. Define your master keys (Loaded from .env in production)
const pepperMap = {
    1: 'old_super_secret_master_key',
    2: 'new_super_secret_master_key'
};

const LATEST_VERSION = 2;

// 2. Hash the password
const password = "my_secure_password";
const hash = await Hash.make(password, pepperMap[LATEST_VERSION], LATEST_VERSION);

console.log(hash); // $2$f3b4c...$a8f9e...
```

### Verifying a Password
```typescript
const isValid = await Hash.verify(password, hash, pepperMap);

if (isValid) {
    console.log("Login Successful!");
} else {
    console.log("Invalid Password.");
}
```

### Why is this secure?
- **Zero Dependencies:** Built entirely on Node's native `node:crypto`. No Python or C++ compilers needed.
- **Offline Immunity:** If a hacker steals your database but doesn't steal your `.env` Pepper, the hashes are mathematically impossible to crack.
- **Side-Channel Protection:** The HMAC step blinds cache-timing attacks, and `timingSafeEqual` prevents byte-guessing over the network.
- **V8 Engine Defenses:** Automatically rejects UTF-16 surrogate ghosts and limits memory allocation to prevent garbage collection thrashing.
