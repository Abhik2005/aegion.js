import { Server } from "../../src/server.js";
import autocannon from "autocannon";

// 1. Boot up Aegion with production settings (no console logging on every request)
const app = new Server({ port: 3000 });

// Register routes
app.register([
  {
    method: "GET",
    path: "/json",
    middlewares: [],
    handler: (ctx) => {
      ctx.json({ message: "Hello, World!", timestamp: Date.now() });
    },
  },
  {
    method: "GET",
    path: "/text",
    middlewares: [],
    handler: (ctx) => {
      ctx.res.setHeader("Content-Type", "text/plain");
      ctx.res.end("Hello, World!");
    },
  },
]);

// Start the server
app.start(async () => {
  console.log("🔥 Server booted. Starting extreme load test in 2 seconds...");

  // Give Node.js a moment to warm up
  await new Promise((r) => setTimeout(r, 2000));

  console.log("🚀 Launching Autocannon against /json route...");

  // 2. Configure Autocannon
  const instance = autocannon(
    {
      url: "http://localhost:3000/json",
      connections: 1000, // 1000 concurrent connections
      pipelining: 20, // Pipeline 20 requests per connection
      duration: 15, // Run for 15 seconds
    },
    console.log,
  );

  // Show real-time progress bar
  autocannon.track(instance, { renderProgressBar: true });

  // 3. When finished, print results and exit
  instance.on("done", (result) => {
    console.log("\n✅ Benchmark Complete!");
    console.log("--------------------------------------------------");
    console.log(`Requests/sec:   ${result.requests.average}`);
    console.log(`Latency (avg):  ${result.latency.average} ms`);
    console.log(
      `Throughput:     ${(result.throughput.average / 1024 / 1024).toFixed(2)} MB/sec`,
    );
    console.log(`Total Requests: ${result.requests.total}`);
    console.log(`Errors/Timeouts:${result.errors + result.timeouts}`);
    console.log("--------------------------------------------------");
    process.exit(0);
  });
});
