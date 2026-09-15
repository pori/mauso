// Exercises the actual app/static/crypto.js (a real import) against a fresh
// fake IndexedDB per test, mirroring notes_store.test.mjs's pattern. Covers
// the "documents"/"doc_chunks" object stores' CRUD -- the first client-side
// storage primitive for #13 (moving RAG documents off the backend). Nothing
// here wires this into the Files page yet, same as images_store.test.mjs /
// notes_store.test.mjs predate their pages actually using them.
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

test("storeDocument/loadDocument round-trip a document through the docs subkey", async () => {
  const Crypto = await freshCrypto();
  const docsKey = await Crypto.deriveSubkey(randomRawKeyBits(), "mauso-docs-key");
  const document = { id: "d1", filename: "Q3 plan.md", size_bytes: 1234, status: "indexed" };

  await Crypto.storeDocument(docsKey, document);
  const loaded = await Crypto.loadDocument(docsKey, "d1");

  assert.deepEqual(loaded, document);
});

test("a different subkey (e.g. the notes one) can't decrypt a stored document", async () => {
  const Crypto = await freshCrypto();
  const rawBits = randomRawKeyBits();
  const docsKey = await Crypto.deriveSubkey(rawBits, "mauso-docs-key");
  const notesKey = await Crypto.deriveSubkey(rawBits, "mauso-notes-key");

  await Crypto.storeDocument(docsKey, { id: "d1", filename: "secret.md", status: "indexed" });

  await assert.rejects(() => Crypto.loadDocument(notesKey, "d1"));
});

test("loadDocument returns null for an id that was never stored", async () => {
  const Crypto = await freshCrypto();
  const docsKey = await Crypto.deriveSubkey(randomRawKeyBits(), "mauso-docs-key");

  const loaded = await Crypto.loadDocument(docsKey, "does-not-exist");

  assert.equal(loaded, null);
});

test("deleteDocument removes a stored document", async () => {
  const Crypto = await freshCrypto();
  const docsKey = await Crypto.deriveSubkey(randomRawKeyBits(), "mauso-docs-key");
  await Crypto.storeDocument(docsKey, { id: "d1", filename: "temp.md", status: "indexed" });

  await Crypto.deleteDocument("d1");
  const loaded = await Crypto.loadDocument(docsKey, "d1");

  assert.equal(loaded, null);
});

test("listDocumentRecords decrypts and returns every stored document, most recently updated first", async () => {
  const Crypto = await freshCrypto();
  const docsKey = await Crypto.deriveSubkey(randomRawKeyBits(), "mauso-docs-key");

  // A small delay between writes -- storeDocument's ordering key is
  // Date.now(), which has only millisecond resolution and can otherwise
  // tie between two back-to-back calls, making the sort assertion below
  // flaky rather than a real ordering bug.
  await Crypto.storeDocument(docsKey, { id: "d1", filename: "first.md", status: "indexed" });
  await new Promise((resolve) => setTimeout(resolve, 5));
  await Crypto.storeDocument(docsKey, { id: "d2", filename: "second.md", status: "indexed" });

  const records = await Crypto.listDocumentRecords(docsKey);

  assert.deepEqual(records.map((r) => r.filename), ["second.md", "first.md"]);
});

test("storeDocChunk/listDocChunksForDocument round-trip chunks scoped to a document id", async () => {
  const Crypto = await freshCrypto();
  const docsKey = await Crypto.deriveSubkey(randomRawKeyBits(), "mauso-docs-key");
  const chunkA = { id: "d1:0", document_id: "d1", chunk_index: 0, text: "part one", vector: [1, 0] };
  const chunkB = { id: "d1:1", document_id: "d1", chunk_index: 1, text: "part two", vector: [0, 1] };
  const otherDocChunk = { id: "d2:0", document_id: "d2", chunk_index: 0, text: "unrelated", vector: [1, 1] };

  await Crypto.storeDocChunk(docsKey, chunkA);
  await Crypto.storeDocChunk(docsKey, chunkB);
  await Crypto.storeDocChunk(docsKey, otherDocChunk);

  const chunks = await Crypto.listDocChunksForDocument(docsKey, "d1");

  assert.deepEqual(chunks.map((c) => c.id).sort(), ["d1:0", "d1:1"]);
});

test("deleteDocChunksForDocument removes only that document's chunks", async () => {
  const Crypto = await freshCrypto();
  const docsKey = await Crypto.deriveSubkey(randomRawKeyBits(), "mauso-docs-key");
  await Crypto.storeDocChunk(docsKey, { id: "d1:0", document_id: "d1", chunk_index: 0, text: "a", vector: [1] });
  await Crypto.storeDocChunk(docsKey, { id: "d2:0", document_id: "d2", chunk_index: 0, text: "b", vector: [1] });

  await Crypto.deleteDocChunksForDocument("d1");

  assert.deepEqual(await Crypto.listDocChunksForDocument(docsKey, "d1"), []);
  assert.equal((await Crypto.listDocChunksForDocument(docsKey, "d2")).length, 1);
});
