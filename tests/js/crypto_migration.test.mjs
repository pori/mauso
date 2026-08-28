// Exercises the actual app/static/crypto.js (a real import, not a
// reimplementation) against a fresh fake IndexedDB per test. Covers the
// PBKDF2 iteration-count migration: a brand-new vault should get the
// current (stronger) default, while a vault that already has a salt on
// disk but no recorded iteration count -- i.e. one created before this
// field existed -- must be backfilled with the OLD count it was actually
// derived with, so existing encrypted conversations keep decrypting.
import assert from "node:assert/strict";
import { test } from "node:test";
import { makeFakeIndexedDB } from "./fake_indexeddb.mjs";

const CRYPTO_JS_URL = new URL("../../app/static/crypto.js", import.meta.url);

async function freshCrypto() {
  globalThis.indexedDB = makeFakeIndexedDB();
  // Bust the ESM module cache so each test gets crypto.js's functions
  // talking to *this* test's fake indexedDB rather than a previous one --
  // the functions read globalThis.indexedDB fresh on every call, but a
  // cache-busted import keeps each test fully isolated regardless.
  return import(`${CRYPTO_JS_URL.href}?t=${Date.now()}-${Math.random()}`);
}

test("a brand-new vault is created with the current default iteration count", async () => {
  const Crypto = await freshCrypto();
  assert.equal(await Crypto.hasExistingSalt(), false);

  await Crypto.getOrCreateSalt();
  const iterations = await Crypto.getKdfIterations();

  assert.equal(iterations, 600000);
});

test("a pre-existing vault (salt on disk, no recorded count) is backfilled with the legacy count", async () => {
  const Crypto = await freshCrypto();

  // Trigger schema creation first (crypto.js's own openDB() creates the
  // object stores on first open), then seed the meta store directly with
  // only a salt -- simulating a vault created before kdfIterations was
  // ever recorded.
  assert.equal(await Crypto.hasExistingSalt(), false);
  const db = await new Promise((resolve, reject) => {
    const req = globalThis.indexedDB.open("mauso", 1);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  await new Promise((resolve, reject) => {
    const req = db.transaction("meta").objectStore("meta").put({ key: "salt", value: "ZmFrZS1zYWx0" });
    req.onsuccess = resolve;
    req.onerror = () => reject(req.error);
  });

  assert.equal(await Crypto.hasExistingSalt(), true);

  await Crypto.getOrCreateSalt();
  const iterations = await Crypto.getKdfIterations();

  assert.equal(iterations, 250000);
});

test("deriveKey with the legacy iteration count still decrypts data it originally encrypted", async () => {
  const Crypto = await freshCrypto();
  const salt = await Crypto.getOrCreateSalt();

  const legacyKey = await Crypto.deriveKey("correct horse battery staple", salt, 250000);
  const record = await Crypto.saveConversation(legacyKey, "convo-1", { title: "t", messages: [] });

  // Re-deriving with the same passphrase/salt/iterations (as getKdfIterations
  // would return for a backfilled legacy vault) must reproduce a key that
  // decrypts what the original key encrypted.
  const rederivedKey = await Crypto.deriveKey("correct horse battery staple", salt, 250000);
  const loaded = await Crypto.loadConversation(rederivedKey, "convo-1");

  assert.deepEqual(loaded, { title: "t", messages: [] });
  assert.equal(record.id, "convo-1");
});

test("deriveKey with a different iteration count produces a key that fails to decrypt", async () => {
  const Crypto = await freshCrypto();
  const salt = await Crypto.getOrCreateSalt();

  const keyAt250k = await Crypto.deriveKey("hunter2", salt, 250000);
  await Crypto.saveConversation(keyAt250k, "convo-1", { title: "t", messages: [] });

  const keyAt600k = await Crypto.deriveKey("hunter2", salt, 600000);
  await assert.rejects(() => Crypto.loadConversation(keyAt600k, "convo-1"));
});
