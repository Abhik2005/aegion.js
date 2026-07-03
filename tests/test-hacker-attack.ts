import { Hash } from '../src/security/hash.js';
import * as crypto from 'node:crypto';

import * as buffer from 'node:buffer';

async function simulate() {
    console.log("=========================================");
    console.log("🛡️ AEGION SECURITY LAB: VOID-TIER SIMULATION");
    console.log("=========================================\n");

    const PEPPERS = { 1: crypto.randomBytes(32).toString('hex') };
    const TARGET_PASSWORD = "super_secret_password_123";
    const targetHash = await Hash.make(TARGET_PASSWORD, PEPPERS[1], 1);
    
    console.log("--- SCENARIO 32: ASYNCHRONOUS MEMORY MUTATION (RACE CONDITION) ---");
    console.log("Hacker attempts to modify the Pepper Map OR Options object exactly while the C++ thread is processing the hash, trying to poison the callback context.");
    
    const maliciousMap = { 1: PEPPERS[1] };
    const maliciousOpts = { cost: 16384 };
    
    // Start verification
    const verifyPromise = Hash.verify(TARGET_PASSWORD, targetHash, maliciousMap, maliciousOpts);
    
    // Mutate the objects immediately before C++ returns
    delete maliciousMap[1];
    maliciousOpts.cost = 1048576;
    
    const raceResult = await verifyPromise;
    console.log(`[HACKER] Did mutating the objects mid-flight crash the verify function?`);
    if (raceResult === true) {
        console.log(`[RESULT] 🟢 SUCCESS! Aegion safely clones configuration before passing to C++, isolating it from JS memory mutation during async operations.\n`);
    } else {
        console.log(`[RESULT] 🔴 FAILURE! Mid-flight mutation corrupted the verification process!\n`);
    }

    console.log("--- SCENARIO 33: HEXADECIMAL CASE-SENSITIVITY EXPLOIT ---");
    console.log("Hacker modifies the database hash to use uppercase hex characters to try and bypass strict buffer equality checks.");
    
    const parts = targetHash.split('$');
    const upperCaseHash = `$${parts[1]}$${parts[2].toUpperCase()}$${parts[3].toUpperCase()}`;
    
    const caseResult = await Hash.verify(TARGET_PASSWORD, upperCaseHash, PEPPERS);
    console.log(`[HACKER] Did uppercase hex bypass the strict buffer comparison?`);
    if (caseResult === false) {
        console.log(`[RESULT] 🟢 SUCCESS! Modifying the case of the salt string correctly changes the cryptographic bytes, securely failing the verification instead of bypassing it.\n`);
    } else {
        console.log(`[RESULT] 🔴 FAILURE! Case modification bypassed verification!\n`);
    }

    console.log("--- SCENARIO 34: MAXIMUM V8 TYPED-ARRAY EXHAUSTION ---");
    console.log("Hacker requests a key length equal to the absolute physical maximum of Node's V8 Buffer constants (approx 4.2 Gigabytes) to bypass RangeError and trigger a hard C++ Abort.");
    
    const MAX_BUFFER_LENGTH = buffer.constants.MAX_LENGTH; // Usually 4294967296 on 64-bit
    let maxBufferCrash = false;
    
    try {
        await Hash.verify(TARGET_PASSWORD, targetHash, PEPPERS, { keylen: MAX_BUFFER_LENGTH });
    } catch (e) {
        console.log(`[SYS] Node returned: ${e.message}`);
        maxBufferCrash = true;
    }
    
    if (maxBufferCrash) {
        console.log(`[RESULT] 🟢 SUCCESS! Node.js successfully throws a RangeError for the physical maximum Buffer size instead of aborting the process.\n`);
    } else {
        console.log(`[RESULT] 🔴 FAILURE! The process hung or crashed!\n`);
    }

    console.log("--- SCENARIO 35: CRYPTOGRAPHIC SALT MALFORMATION ---");
    console.log("Hacker injects non-hex characters into the salt string in the database (e.g. 'GHIJKLM').");
    console.log("If Scrypt blindly trusts the salt as a utf-8 string, it might produce predictable hashes.");
    
    const malformedSaltHash = `$1$GHIJKLMNOPQRSTUVWXYZ$${parts[3]}`;
    const saltResult = await Hash.verify(TARGET_PASSWORD, malformedSaltHash, PEPPERS);
    
    console.log(`[HACKER] Did injecting non-hex chars into the salt allow verification? ${saltResult}`);
    if (saltResult === false) {
        console.log(`[RESULT] 🟢 SUCCESS! Modifying the salt strictly breaks the Scrypt output, failing the strict Buffer equality check.\n`);
    } else {
        console.log(`[RESULT] 🔴 FAILURE! Salt malformation bypassed verification.\n`);
    }

    console.log("=========================================");
    console.log("🛡️ VOID SIMULATION COMPLETE.");
    console.log("=========================================");
}

simulate().catch(console.error);
