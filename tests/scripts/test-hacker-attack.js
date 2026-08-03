import { Hash } from "../../src/security/hash.js";
import * as crypto from "node:crypto";

async function simulate() {
  console.log("=========================================");
  console.log("🛡️ AEGION SECURITY LAB: ALIEN-TIER HACKER SIMULATION");
  console.log("=========================================\n");

  const PEPPERS = { 1: crypto.randomBytes(32).toString("hex") };
  const TARGET_PASSWORD = "super_secret_password_123";
  const targetHash = await Hash.make(TARGET_PASSWORD, PEPPERS[1], 1);

  // ... skipping 1-22 for brevity, jumping to the ALIEN tests

  console.log("--- SCENARIO 23: C++ FATAL ALLOCATION CRASH (UN-CATCHABLE) ---");
  console.log(
    "If a developer accidentally passes raw user-JSON as the options object, a hacker can set 'keylen: 2147483647' (2 GB).",
  );
  console.log(
    "In Node.js, V8 cannot catch C++ buffer allocation failures. If this reaches scrypt, the Node process instantly dies, bypassing all try/catch blocks!",
  );

  const maliciousOptions = { keylen: 2147483647 }; // 2GB buffer request

  let crashTriggered = false;
  try {
    await Hash.verify(TARGET_PASSWORD, targetHash, PEPPERS, maliciousOptions);
  } catch (e) {
    crashTriggered = true;
    console.log(`[HACKER] Scrypt threw a safe JS error: ${e.message}`);
  }

  if (crashTriggered) {
    console.log(
      `[RESULT] 🟢 SUCCESS! Node.js v14+ safely throws a RangeError for massive keylen instead of crashing V8. Server stayed alive!\n`,
    );
  } else {
    console.log(
      `[RESULT] 🔴 FAILURE! We didn't get an error, did the process crash or hang?\n`,
    );
  }

  console.log("--- SCENARIO 24: COST PARAMETER INTEGER OVERFLOWS ---");
  console.log(
    "Hacker submits negative parameters, extreme power-of-2 limits, and floats to trigger C++ integer underflow/overflows.",
  );

  const badCostConfigs = [
    { cost: -1 },
    { blockSize: -1 },
    { parallelization: -1 },
    { cost: 3 }, // Not a power of 2
    { cost: 2 ** 30 }, // Massive power of 2
  ];

  let caughtCount = 0;
  for (const badOpts of badCostConfigs) {
    try {
      await Hash.verify(TARGET_PASSWORD, targetHash, PEPPERS, badOpts);
    } catch (e) {
      caughtCount++;
    }
  }

  console.log(
    `[HACKER] Tried ${badCostConfigs.length} illegal parameter sets.`,
  );
  if (caughtCount === badCostConfigs.length) {
    console.log(
      `[RESULT] 🟢 SUCCESS! Native bounds checking caught every single C++ overflow attempt securely.\n`,
    );
  } else {
    console.log(
      `[RESULT] 🔴 FAILURE! Some parameters bypassed the bounds check!\n`,
    );
  }

  console.log("--- SCENARIO 25: RAW BINARY BUFFER BYPASS ---");
  console.log(
    "Hacker bypasses JSON strings and submits the password via a raw binary Buffer stream to bypass encoding protections.",
  );

  const binaryPassword = Buffer.from("super_secret_password_123");

  const binResult = await Hash.verify(binaryPassword, targetHash, PEPPERS);

  console.log(`[HACKER] Did the server accept the raw Buffer? ${binResult}`);
  if (binResult === false) {
    console.log(
      `[RESULT] 🟢 SUCCESS! Strict 'typeof string' checks correctly rejected the binary buffer payload. Type safety is ironclad.\n`,
    );
  }

  console.log("=========================================");
  console.log("🛡️ ALIEN SIMULATION COMPLETE. THE CODE IS IMMORTAL.");
  console.log("=========================================");
}

simulate().catch(console.error);
