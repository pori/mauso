// Exercises the actual app/static/crypto.js (a real import, not a
// reimplementation) against a fresh fake IndexedDB per test. Covers the
// one-time images migration sentinel added for #11 stage 2
// (hasImagesMigrated/markImagesMigrated): app.js checks this once on boot
// to decide whether to pull legacy server-side images into the "images"
// store, mirroring the same lazy-backfill idiom getOrCreateSalt already
// uses for the PBKDF2 iteration count (see crypto_migration.test.mjs).
import assert from "node:assert/strict";
import { test } from "node:test";
import { makeFakeIndexedDB } from "./fake_indexeddb.mjs";

const CRYPTO_JS_URL = new URL("../../app/static/crypto.js", import.meta.url);

async function freshCrypto() {
  globalThis.indexedDB = makeFakeIndexedDB();
  return import(`${CRYPTO_JS_URL.href}?t=${Date.now()}-${Math.random()}`);
}

test("a brand-new vault has not migrated images yet", async () => {
  const Crypto = await freshCrypto();
  assert.equal(await Crypto.hasImagesMigrated(), false);
});

test("markImagesMigrated flips the sentinel for this vault", async () => {
  const Crypto = await freshCrypto();
  assert.equal(await Crypto.hasImagesMigrated(), false);

  await Crypto.markImagesMigrated();

  assert.equal(await Crypto.hasImagesMigrated(), true);
});

test("the sentinel survives alongside other meta keys (salt, kdfIterations)", async () => {
  const Crypto = await freshCrypto();
  await Crypto.getOrCreateSalt();
  await Crypto.markImagesMigrated();

  assert.equal(await Crypto.hasImagesMigrated(), true);
  assert.equal(await Crypto.hasExistingSalt(), true);
});

test("checking the sentinel repeatedly is idempotent and doesn't throw", async () => {
  const Crypto = await freshCrypto();
  assert.equal(await Crypto.hasImagesMigrated(), false);
  assert.equal(await Crypto.hasImagesMigrated(), false);
  await Crypto.markImagesMigrated();
  await Crypto.markImagesMigrated();
  assert.equal(await Crypto.hasImagesMigrated(), true);
});
