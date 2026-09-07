// Exercises the actual app/static/crypto.js (a real import) against a fresh
// fake IndexedDB per test, mirroring crypto_migration.test.mjs's pattern.
// Covers the two primitives added for the client-side image-storage move
// (#11): the shared per-purpose HKDF subkey derivation, and the "images"
// object store's CRUD.
import assert from "node:assert/strict";
import { test } from "node:test";
import { webcrypto } from "node:crypto";
import { makeFakeIndexedDB } from "./fake_indexeddb.mjs";

const CRYPTO_JS_URL = new URL("../../app/static/crypto.js", import.meta.url);

// Node has no global sessionStorage -- a minimal in-memory stand-in, just
// enough for crypto.js's cacheKeyForSession/getSessionKeyRawBits, same
// spirit as fake_indexeddb.mjs's IndexedDB stand-in.
class FakeSessionStorage {
  constructor() { this.map = new Map(); }
  getItem(key) { return this.map.has(key) ? this.map.get(key) : null; }
  setItem(key, value) { this.map.set(key, String(value)); }
  removeItem(key) { this.map.delete(key); }
  clear() { this.map.clear(); }
}

async function freshCrypto() {
  globalThis.indexedDB = makeFakeIndexedDB();
  globalThis.sessionStorage = new FakeSessionStorage();
  return import(`${CRYPTO_JS_URL.href}?t=${Date.now()}-${Math.random()}`);
}

function randomRawKeyBits() {
  return webcrypto.getRandomValues(new Uint8Array(32)).buffer;
}

test("deriveSubkey produces a key that can encrypt and decrypt its own data", async () => {
  const Crypto = await freshCrypto();
  const rawBits = randomRawKeyBits();
  const imageKey = await Crypto.deriveSubkey(rawBits, "mauso-image-key");

  const record = await Crypto.storeImage(imageKey, "img-1", new Uint8Array([1, 2, 3, 4]), "image/png");
  const loaded = await Crypto.loadImage(imageKey, "img-1");

  assert.equal(record.id, "img-1");
  assert.deepEqual(Array.from(loaded.bytes), [1, 2, 3, 4]);
  assert.equal(loaded.contentType, "image/png");
});

test("deriveSubkey is deterministic for the same raw bits and info label", async () => {
  const Crypto = await freshCrypto();
  const rawBits = randomRawKeyBits();

  const keyA = await Crypto.deriveSubkey(rawBits, "mauso-image-key");
  await Crypto.storeImage(keyA, "img-1", new Uint8Array([9, 9, 9]), "image/png");

  const keyB = await Crypto.deriveSubkey(rawBits, "mauso-image-key");
  const loaded = await Crypto.loadImage(keyB, "img-1");

  assert.deepEqual(Array.from(loaded.bytes), [9, 9, 9]);
});

test("two different info labels derive isolated subkeys -- one can't decrypt the other's data", async () => {
  const Crypto = await freshCrypto();
  const rawBits = randomRawKeyBits();

  const imageKey = await Crypto.deriveSubkey(rawBits, "mauso-image-key");
  const notesKey = await Crypto.deriveSubkey(rawBits, "mauso-notes-key");

  await Crypto.storeImage(imageKey, "img-1", new Uint8Array([1, 2, 3]), "image/png");

  await assert.rejects(() => Crypto.loadImage(notesKey, "img-1"));
});

test("loadImage returns null for an id that was never stored", async () => {
  const Crypto = await freshCrypto();
  const imageKey = await Crypto.deriveSubkey(randomRawKeyBits(), "mauso-image-key");

  const loaded = await Crypto.loadImage(imageKey, "does-not-exist");

  assert.equal(loaded, null);
});

test("deleteImage removes a stored image", async () => {
  const Crypto = await freshCrypto();
  const imageKey = await Crypto.deriveSubkey(randomRawKeyBits(), "mauso-image-key");
  await Crypto.storeImage(imageKey, "img-1", new Uint8Array([1]), "image/png");

  await Crypto.deleteImage("img-1");
  const loaded = await Crypto.loadImage(imageKey, "img-1");

  assert.equal(loaded, null);
});

test("listImageIds returns every stored image's id", async () => {
  const Crypto = await freshCrypto();
  const imageKey = await Crypto.deriveSubkey(randomRawKeyBits(), "mauso-image-key");
  await Crypto.storeImage(imageKey, "img-1", new Uint8Array([1]), "image/png");
  await Crypto.storeImage(imageKey, "img-2", new Uint8Array([2]), "image/jpeg");

  const ids = await Crypto.listImageIds();

  assert.deepEqual(ids.sort(), ["img-1", "img-2"]);
});

test("getSessionKeyRawBits returns null when nothing is cached for this tab session", async () => {
  const Crypto = await freshCrypto();
  sessionStorage.clear();

  assert.equal(await Crypto.getSessionKeyRawBits(), null);
});

test("getSessionKeyRawBits round-trips the bits cacheKeyForSession stored", async () => {
  const Crypto = await freshCrypto();
  const salt = await Crypto.getOrCreateSalt();
  const key = await Crypto.deriveKey("correct horse battery staple", salt);

  await Crypto.cacheKeyForSession(key);
  const rawBits = Crypto.getSessionKeyRawBits();
  const imageKey = await Crypto.deriveSubkey(rawBits, "mauso-image-key");

  // Just proving the round-tripped bits are usable key material.
  await Crypto.storeImage(imageKey, "img-1", new Uint8Array([7]), "image/png");
  const loaded = await Crypto.loadImage(imageKey, "img-1");
  assert.deepEqual(Array.from(loaded.bytes), [7]);
});
