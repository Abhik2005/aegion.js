import { Server } from "../../src/server.js";
import autocannon from "autocannon";

const app = new Server({ port: 3000 });

app.register([
  {
    method: "POST",
    path: "/crash",
    middlewares: [],
    handler: async (ctx) => {
      // Read the incoming JSON body. This forces the server to buffer the data in RAM.
      try {
        const body = await ctx.json();
        ctx.json({ success: true, size: JSON.stringify(body).length });
      } catch (err) {
        ctx.res.statusCode = 400;
        ctx.res.end("Bad Request");
      }
    },
  },
]);

app.start(async () => {
  console.log(
    "🔥 Server booted. Initiating RAM exhaustion attack (OOM Test)...",
  );

  // We are going to send a massive 500KB JSON string on every single request.
  const heavyPayload = JSON.stringify({ attack_data: "A".repeat(500_000) });

  const instance = autocannon(
    {
      url: "http://localhost:3000/crash",
      method: "POST",
      body: heavyPayload,
      headers: {
        "content-type": "application/json",
      },
      connections: 5000, // 1000 concurrent connections
      pipelining: 100, // Each connection pipelines 10 heavy requests at once
      duration: 30, // Run for 30 seconds (if it survives that long)
    },
    (err, result) => {
      if (err) {
        console.error("Autocannon error:", err);
      } else {
        console.log(
          "\n❌ The server somehow survived (this means it successfully garbage collected!).",
        );
        process.exit(0);
      }
    },
  );

  autocannon.track(instance, { renderProgressBar: true });
});
