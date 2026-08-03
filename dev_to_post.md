---
title: "Why I built a new Node.js Framework: 9,000+ RPS, 100% Coverage, and Zero Dependencies"
published: false
tags: nodejs, javascript, webdev, security
---

If you’re building a web server in Node.js today, you usually reach for Express or Fastify. They are incredible tools, but as I kept building backend applications, I ran into the same frustrations:

1. **The Middleware Trap:** Global middleware chains make it impossible to track how a request is mutated before it reaches your route handler. 
2. **Security is an Afterthought:** You have to download 10 different third-party plugins just to get basic rate-limiting, CSRF protection, and header security. 
3. **Bloat:** I was tired of installing a framework and suddenly having 50+ transitive dependencies in my `node_modules`.

I wanted a framework that was **Secure by Default** and built on **Functional Composition** rather than mutable middleware.

So, I built **[Aegion.js](https://github.com/Abhik2005/aegion.js)**.

---

## 🛡️ What is Aegion.js?

Aegion is a blazing fast, hyper-secure, zero-dependency Node.js web framework. 

Instead of Express's `(req, res, next)` middleware pattern, Aegion uses functional composition. You wrap your core business logic in pure, predictable context managers.

Here is what a secure route looks like:

```typescript
import { Server, Context, Pipeline, RateLimit, CSRF } from 'aegion';

const app = new Server();

app.router.post('/api/secure-data', 
  Pipeline.compose(
    RateLimit.middleware({ windowMs: 60000, max: 100 }), // Built-in Rate Limiting
    CSRF.protect(),                                      // Built-in CSRF
    async (ctx: Context) => {
      // Type-safe, predictable, and isolated
      ctx.json({ success: true, message: "Welcome to the fortress." });
    }
  )
);

app.start(3000);
```

## 🚀 Performance: 9,000+ Requests Per Second
Because Aegion has **zero dependencies** and uses a highly optimized `O(1)` Radix Tree for routing, the performance is insane. 

In local load tests using `autocannon` (100 concurrent connections over 10 seconds), the bare routing engine sustained an average of **over 9,000 requests per second** with a microscopic P99 latency of just `16ms`. Even when loaded down with heavy cryptographic middlewares like Argon2 and CSRF generation, it maintains an incredibly respectable 4,500 RPS.

## 🔒 Enterprise Grade Security (Built-in)
Security wasn't an afterthought; it was the entire point of the project. Out of the box, you get:
- **Brute Force Protection:** Built-in IP tracking and exponential backoff.
- **CSRF & XSS Defenses:** Automatic secure token generation and validation.
- **Content Security Policies (CSP) & Secure Headers:** Pre-configured to pass OWASP standards.
- **Secure File Uploads:** Built-in multipart parsers that stream data to disk to prevent RAM-exhaustion (OOM) attacks.

Furthermore, the entire codebase is verified by rigorous security pipelines. We enforce **Static Application Security Testing (SAST)** with CodeQL/ESLint, **Software Composition Analysis (SCA)** on every PR, and dynamic vulnerability scanning using the **OWASP ZAP** docker container. 

Oh, and the entire framework has **100.00% Line Code Coverage**. Every single branch and edge case is tested.

## 🤝 Try it out!
I built this for developers who want raw performance without sacrificing the peace of mind that comes from enterprise-grade security.

Check out the repository, and let me know what you think! I’d love feedback from the community on the functional composition pattern.

- **GitHub Repository:** [github.com/Abhik2005/aegion.js](https://github.com/Abhik2005/aegion.js)
- **NPM Package:** `npm i aegion.js`

*If you find it interesting, a ⭐️ on GitHub would mean the world to me!*
