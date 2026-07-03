# Aegion Enterprise Strict Folder Structure

To fully leverage Aegion’s `autoload()` capabilities and maintain a hyper-scalable, enterprise-grade architecture, we enforce a strict separation of concerns. 

Because Aegion’s router scales at `O(k)` (independent of route count), you can split your application into hundreds of tiny, domain-driven files without any performance penalty.

---

## The Recommended Enterprise Structure

```text
my-aegion-app/
├── .env                     # Local environment variables (Parsed natively by Aegion)
├── package.json
├── tsconfig.json
└── src/
    ├── app.ts               # The main entry point (Starts the Server)
    ├── config/              
    │   └── env.ts           # Exports the Zod Schema for environment validation
    ├── middlewares/
    │   ├── auth.ts          # Authentication pipeline logic
    │   └── logger.ts        # Request logging middleware
    ├── services/
    │   ├── db.ts            # Database connections
    │   └── email.ts         # External API integrations
    └── api/                 # 📂 AUTOLOAD DIRECTORY
        ├── index.ts         # Base routes (e.g., GET /api/health)
        ├── users/
        │   └── routes.ts    # User routes (e.g., /api/users, /api/users/:id)
        ├── products/
        │   └── routes.ts    # Product catalog routes
        └── payments/
            └── routes.ts    # Stripe/payment webhook routes
```

---

## 1. The Entry Point (`src/app.ts`)

Your main file should be absolutely minimal. It should only configure the server, define global settings (like CORS and Rate Limits), invoke the autoloader, and start listening.

```typescript
import { Server } from "aegion";
import { envSchema } from "./config/env";

const app = new Server({
    port: 3000,
    env: envSchema,
    cors: { origin: "*", credentials: true },
    rateLimit: { windowMs: 10 * 60 * 1000, maxRequests: 500 }
});

// Automatically recursively scans the /api folder and registers all routes!
await app.autoload("./src/api");

app.start();
```

---

## 2. The Autoload Directory (`src/api/`)

Aegion’s `autoload()` function recursively scans the target directory for any file containing a `default` export of a `RouteGroup` array. 

By mapping routes physically to the folder structure, a new developer can instantly guess where the code for `/api/users/profile` lives (`src/api/users/routes.ts`).

### Example: `src/api/users/routes.ts`
```typescript
import { group, get, post } from "aegion";
import { requireAuth } from "../../middlewares/auth";

// The array MUST be the default export for the autoloader to detect it
export default [
    group("/users", 
        // 1. Unprotected Route
        get("/public-list", (ctx) => {
            return { users: ["Alice", "Bob"] };
        }),
        
        // 2. Protected Route Group (Applies middleware to all children)
        group("/secure", requireAuth, 
            get("/profile", (ctx) => {
                // ctx.user is injected by the requireAuth middleware
                return { profile: ctx.user };
            })
        )
    )
];
```

---

## 3. Pure Middlewares (`src/middlewares/`)

Middlewares in Aegion operate on a strict **Fail-Closed State Machine**. They should be isolated in their own directory. They are completely pure functions that read from the `Context` and either mutate it (e.g., injecting `ctx.user`) or abort the pipeline.

### Example: `src/middlewares/auth.ts`
```typescript
import { Context } from "aegion";

export const requireAuth = async (ctx: Context) => {
    const token = ctx.req.headers.authorization;
    
    if (!token) {
        // Automatically serializes JSON and ends the response
        // By NOT returning ctx.next(), the pipeline is forcefully aborted
        return ctx.status(401).json({ error: "Unauthorized" });
    }
    
    // Inject custom data into the Context object for the next handler
    ctx.user = { id: 1, role: "admin" };
    
    // Signal the pipeline to safely continue to the route handler
    return ctx.next();
};
```

---

## Summary of the Architecture
- **No Regex Spaghetti:** Because Aegion routes are defined functionally using `group()`, you never have to trace linear regex mappings across 15 different files.
- **Fail-Safe Decoupling:** If the developer working on `payments/routes.ts` makes a fatal syntax error, it won't take down the `users/routes.ts` pipeline.
- **Zod Centralization:** The `.env` variables are completely validated at startup via `config/env.ts` and made available globally throughout the app via `app.env`, eliminating dangerous `process.env` lookups scattered across files.
