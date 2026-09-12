// Exercises the actual app/static/crypto.js (a real import) against a fresh
// fake IndexedDB per test, mirroring images_store.test.mjs's pattern.
// Covers the "notes" object store's CRUD -- the first client-side storage
// primitive for #12 (moving saved notes off the backend). Nothing here
// wires this into the Notes page yet, same as images_store.test.mjs
// predates app.js actually using storeImage/loadImage.
import assert from "node:assert/strict";
import { test } from "node:test";
import { webcrypto } from "node:crypto";
import { makeFakeIndexedDB } from "./fake_indexeddb.mjs";

const CRYPTO_JS_URL = new URL("../../app/static/crypto.js", import.meta.url);

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

test("storeNote/loadNote round-trip a note through the notes subkey", async () => {
  const Crypto = await freshCrypto();
  const notesKey = await Crypto.deriveSubkey(randomRawKeyBits(), "mauso-notes-key");
  const note = { id: "n1", title: "Standup notes", content_markdown: "daily sync", tags: ["work"] };

  await Crypto.storeNote(notesKey, note);
  const loaded = await Crypto.loadNote(notesKey, "n1");

  assert.deepEqual(loaded, note);
});

test("a different subkey (e.g. the image one) can't decrypt a stored note", async () => {
  const Crypto = await freshCrypto();
  const rawBits = randomRawKeyBits();
  const notesKey = await Crypto.deriveSubkey(rawBits, "mauso-notes-key");
  const imageKey = await Crypto.deriveSubkey(rawBits, "mauso-image-key");

  await Crypto.storeNote(notesKey, { id: "n1", title: "Secret", content_markdown: "" });

  await assert.rejects(() => Crypto.loadNote(imageKey, "n1"));
});

test("loadNote returns null for an id that was never stored", async () => {
  const Crypto = await freshCrypto();
  const notesKey = await Crypto.deriveSubkey(randomRawKeyBits(), "mauso-notes-key");

  const loaded = await Crypto.loadNote(notesKey, "does-not-exist");

  assert.equal(loaded, null);
});

test("deleteNote removes a stored note", async () => {
  const Crypto = await freshCrypto();
  const notesKey = await Crypto.deriveSubkey(randomRawKeyBits(), "mauso-notes-key");
  await Crypto.storeNote(notesKey, { id: "n1", title: "Temp", content_markdown: "" });

  await Crypto.deleteNote("n1");
  const loaded = await Crypto.loadNote(notesKey, "n1");

  assert.equal(loaded, null);
});

test("listNoteRecords decrypts and returns every stored note, most recently updated first", async () => {
  const Crypto = await freshCrypto();
  const notesKey = await Crypto.deriveSubkey(randomRawKeyBits(), "mauso-notes-key");

  // A small delay between writes -- storeNote's ordering key is
  // Date.now(), which has only millisecond resolution and can otherwise
  // tie between two back-to-back calls, making the sort assertion below
  // flaky rather than a real ordering bug.
  await Crypto.storeNote(notesKey, { id: "n1", title: "First", content_markdown: "" });
  await new Promise((resolve) => setTimeout(resolve, 5));
  await Crypto.storeNote(notesKey, { id: "n2", title: "Second", content_markdown: "" });

  const records = await Crypto.listNoteRecords(notesKey);

  assert.deepEqual(records.map((r) => r.title), ["Second", "First"]);
});

test("storeNote overwrites an existing note with the same id", async () => {
  const Crypto = await freshCrypto();
  const notesKey = await Crypto.deriveSubkey(randomRawKeyBits(), "mauso-notes-key");
  await Crypto.storeNote(notesKey, { id: "n1", title: "Original", content_markdown: "" });

  await Crypto.storeNote(notesKey, { id: "n1", title: "Edited", content_markdown: "" });
  const loaded = await Crypto.loadNote(notesKey, "n1");
  const records = await Crypto.listNoteRecords(notesKey);

  assert.equal(loaded.title, "Edited");
  assert.equal(records.length, 1);
});
