import { Hash } from "../../src/index.js";

async function run() {
  const PEPPER_MAP = {
    1: "old_pepper_secret_key_32_bytes_long",
    2: "new_pepper_secret_key_32_bytes_long",
  };

  console.log("--- Peppered Scrypt Test ---");
  console.log("Generating hash with version 1...");

  const startHash = Date.now();
  const hash = await Hash.make("my_secure_password", PEPPER_MAP[1], 1);
  const endHash = Date.now();

  console.log(`Generated Hash: ${hash}`);
  console.log(`Hash took: ${endHash - startHash}ms\n`);

  console.log("Verifying with CORRECT password and pepper...");
  const startVerify1 = Date.now();
  const isValid = await Hash.verify("my_secure_password", hash, PEPPER_MAP);
  const endVerify1 = Date.now();
  console.log(`Valid: ${isValid} (Took: ${endVerify1 - startVerify1}ms)\n`);

  console.log("Verifying with INCORRECT password...");
  const startVerify2 = Date.now();
  const isInvalid = await Hash.verify("wrong_password", hash, PEPPER_MAP);
  const endVerify2 = Date.now();
  console.log(`Valid: ${isInvalid} (Took: ${endVerify2 - startVerify2}ms)\n`);

  console.log("Simulating Key Rotation...");
  console.log("Generating hash with version 2 (New Key)...");
  const hash2 = await Hash.make("my_secure_password", PEPPER_MAP[2], 2);
  console.log(`Generated Hash: ${hash2}`);

  console.log("Verifying version 2 with pepper map...");
  const isValid2 = await Hash.verify("my_secure_password", hash2, PEPPER_MAP);
  console.log(`Valid: ${isValid2}\n`);

  console.log("Trying to verify version 2 with WRONG MAP (deleted key)...");
  const DELETED_MAP = { 1: "old_pepper_secret_key_32_bytes_long" };
  const isValid3 = await Hash.verify("my_secure_password", hash2, DELETED_MAP);
  console.log(`Valid (Deleted Key): ${isValid3}`);
}

run().catch(console.error);
