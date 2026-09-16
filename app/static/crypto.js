// Client-side encryption for mauso conversation history. Nothing in this
// file ever sends the passphrase or derived key anywhere -- the backend
// never sees either. A wrong passphrase is detected naturally: AES-GCM
// decryption fails its built-in authentication check, so there's no need
// for a separately stored "verifier" value.
//
// Storage: IndexedDB, database "mauso":
//   - "meta" store: {key: "salt", value: <16 random bytes, base64>}
//   - "conversations" store: {id, updatedAt, iv, ciphertext} -- iv/ciphertext
//     are base64; ciphertext decrypts to {title, messages, activeDocumentIds}.
//
// The derived key is also cached in sessionStorage (see cacheKeyForSession/
// restoreKeyFromSession below) so navigating between Chat/Files/Settings --
// each a real page load, not SPA routing -- doesn't re-prompt for the
// passphrase every time. sessionStorage is cleared when the tab/window
// closes (or via the Lock button, clearSessionKey()), never written to
// disk. It's exactly as exposed to same-origin XSS as the in-memory
// alternative would be, since there's no untrusted third-party script on
// this page to begin with -- this is a convenience tradeoff, not a
// weakening of the passphrase-never-leaves-the-browser guarantee.

const DB_NAME = "mauso";
const DB_VERSION = 4;
const SESSION_KEY_STORAGE = "mauso_session_key_bits";

// PBKDF2-HMAC-SHA256 iteration count. 600,000 matches OWASP's current
// Password Storage Cheat Sheet minimum (unchanged since its Dec 2022
// revision, last checked here Aug 2026). The PREVIOUS value here was
// 250,000 -- since the derived key depends on this number, bumping it
// changes the key for the SAME passphrase+salt, which would make every
// already-encrypted IndexedDB conversation undecryptable for anyone
// upgrading in place. So this isn't just a constant bump: the iteration
// count used for a given vault is now persisted alongside its salt (see
// getOrCreateSalt/getKdfIterations below) the first time either is read
// after this change -- a brand-new vault gets DEFAULT_ITERATIONS, while a
// pre-existing one (salt already on disk, no count recorded yet) gets
// backfilled with the old value it was actually derived with, so existing
// conversations keep decrypting. This does NOT retroactively strengthen an
// existing vault's KDF -- that would require re-deriving the key and
// re-encrypting every stored conversation under it (a "rotate passphrase"
// feature that doesn't exist yet), so existing installs stay at the old
// iteration count until such a migration is built.
const DEFAULT_ITERATIONS = 600000;
const LEGACY_ITERATIONS = 250000;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("meta")) {
        db.createObjectStore("meta", { keyPath: "key" });
      }
      if (!db.objectStoreNames.contains("conversations")) {
        db.createObjectStore("conversations", { keyPath: "id" });
      }
      // Added in DB_VERSION 2 -- browser-only image storage (see
      // storeImage/loadImage below). Guarded the same way as the two
      // stores above so opening an existing (version-1) database only
      // adds this store, leaving "meta"/"conversations" untouched.
      if (!db.objectStoreNames.contains("images")) {
        db.createObjectStore("images", { keyPath: "id" });
      }
      // Added in DB_VERSION 3 -- browser-only notes storage (see
      // storeNote/loadNote below), the first storage primitive for #12.
      // Not yet read from by the Notes page or attached to /api/chat
      // requests -- that's a later stage, same as the "images" store above
      // predates app.js actually using it.
      if (!db.objectStoreNames.contains("notes")) {
        db.createObjectStore("notes", { keyPath: "id" });
      }
      // Added in DB_VERSION 4 -- browser-only RAG document storage (see
      // storeDocument/storeDocChunk below), the first storage primitive
      // for #13. Not yet read from by the Files page, attached to
      // /api/chat requests, or populated by an upload flow -- that's later
      // work, same as "images"/"notes" predate their pages using them.
      if (!db.objectStoreNames.contains("documents")) {
        db.createObjectStore("documents", { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains("doc_chunks")) {
        db.createObjectStore("doc_chunks", { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx(db, storeName, mode) {
  return db.transaction(storeName, mode).objectStore(storeName);
}

function reqToPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function bufToB64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function b64ToBuf(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

export async function getOrCreateSalt() {
  const db = await openDB();
  const existing = await reqToPromise(tx(db, "meta", "readonly").get("salt"));
  if (existing) {
    const existingIterations = await reqToPromise(tx(db, "meta", "readonly").get("kdfIterations"));
    if (!existingIterations) {
      // Pre-existing vault from before kdfIterations was recorded -- it was
      // derived with the old hardcoded count, so persist that (not
      // DEFAULT_ITERATIONS) to keep decrypting its conversations correctly.
      await reqToPromise(tx(db, "meta", "readwrite").put({ key: "kdfIterations", value: LEGACY_ITERATIONS }));
    }
    return b64ToBuf(existing.value);
  }
  const salt = crypto.getRandomValues(new Uint8Array(16));
  await reqToPromise(tx(db, "meta", "readwrite").put({ key: "salt", value: bufToB64(salt) }));
  await reqToPromise(tx(db, "meta", "readwrite").put({ key: "kdfIterations", value: DEFAULT_ITERATIONS }));
  return salt.buffer;
}

// Reads back the iteration count getOrCreateSalt() persisted for this
// vault -- call after getOrCreateSalt() so the backfill above has run.
export async function getKdfIterations() {
  const db = await openDB();
  const existing = await reqToPromise(tx(db, "meta", "readonly").get("kdfIterations"));
  return existing ? existing.value : DEFAULT_ITERATIONS;
}

export async function hasExistingSalt() {
  const db = await openDB();
  const existing = await reqToPromise(tx(db, "meta", "readonly").get("salt"));
  return !!existing;
}

// Extractable on purpose -- immediately after deriving, the caller caches
// this key for the session (see cacheKeyForSession). Everywhere else that
// hands out a key (restoreKeyFromSession) re-imports it non-extractable.
export async function deriveKey(passphrase, saltBuf, iterations = DEFAULT_ITERATIONS) {
  const enc = new TextEncoder();
  const baseKey = await crypto.subtle.importKey(
    "raw", enc.encode(passphrase), "PBKDF2", false, ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: saltBuf, iterations, hash: "SHA-256" },
    baseKey,
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt", "decrypt"],
  );
}

export async function cacheKeyForSession(key) {
  const raw = await crypto.subtle.exportKey("raw", key);
  sessionStorage.setItem(SESSION_KEY_STORAGE, bufToB64(raw));
}

// Returns a fresh (non-extractable) CryptoKey if a session-cached key
// exists, or null if not (i.e. the passphrase needs to be entered).
export async function restoreKeyFromSession() {
  const cached = sessionStorage.getItem(SESSION_KEY_STORAGE);
  if (!cached) return null;
  const raw = b64ToBuf(cached);
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

export function clearSessionKey() {
  sessionStorage.removeItem(SESSION_KEY_STORAGE);
}

async function encryptJSON(key, obj) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const enc = new TextEncoder();
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv }, key, enc.encode(JSON.stringify(obj)),
  );
  return { iv: bufToB64(iv), ciphertext: bufToB64(ciphertext) };
}

// Throws if the key is wrong -- AES-GCM's auth tag check fails.
async function decryptJSON(key, ivB64, ciphertextB64) {
  const iv = new Uint8Array(b64ToBuf(ivB64));
  const plainBuf = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv }, key, b64ToBuf(ciphertextB64),
  );
  return JSON.parse(new TextDecoder().decode(plainBuf));
}

export async function saveConversation(key, id, data) {
  const db = await openDB();
  const { iv, ciphertext } = await encryptJSON(key, data);
  const record = { id, updatedAt: Date.now(), iv, ciphertext };
  await reqToPromise(tx(db, "conversations", "readwrite").put(record));
  return record;
}

export async function loadConversation(key, id) {
  const db = await openDB();
  const record = await reqToPromise(tx(db, "conversations", "readonly").get(id));
  if (!record) return null;
  return decryptJSON(key, record.iv, record.ciphertext);
}

export async function listConversationRecords() {
  const db = await openDB();
  const records = await reqToPromise(tx(db, "conversations", "readonly").getAll());
  records.sort((a, b) => b.updatedAt - a.updatedAt);
  return records;
}

export async function deleteConversation(id) {
  const db = await openDB();
  await reqToPromise(tx(db, "conversations", "readwrite").delete(id));
}

// Verifies a passphrase by trying to decrypt any one existing conversation.
// Returns true/false/null (null = nothing to verify against yet, i.e. first use).
export async function verifyPassphrase(key) {
  const records = await listConversationRecords();
  if (records.length === 0) return null;
  try {
    await decryptJSON(key, records[0].iv, records[0].ciphertext);
    return true;
  } catch {
    return false;
  }
}

export function newConversationId() {
  return crypto.randomUUID();
}

// --- Per-purpose subkeys (shared primitive for #11/#12/#13's client-side
// storage moves) ---------------------------------------------------------
//
// Deriving a distinct AES-GCM subkey per purpose (images here, notes/docs
// elsewhere) via HKDF -- rather than reusing the conversation key directly
// -- means a leak of one purpose's key can't be used to decrypt another's.
// The input key material is the same raw bits already cached in
// sessionStorage for the conversation key (see cacheKeyForSession); this
// isn't a new exposure, just a second, independent import of those bits.

// Raw bits of the session-cached master key, or null if nothing is cached
// (i.e. the passphrase hasn't been entered this tab session yet).
export function getSessionKeyRawBits() {
  const cached = sessionStorage.getItem(SESSION_KEY_STORAGE);
  return cached ? b64ToBuf(cached) : null;
}

export async function deriveSubkey(rawKeyBits, infoLabel) {
  const ikm = await crypto.subtle.importKey("raw", rawKeyBits, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: new TextEncoder().encode(infoLabel) },
    ikm,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

// --- Browser-only image storage ("images" store) ------------------------
//
// Bytes in, bytes out -- callers own converting to/from whatever they
// actually have (File/Blob/data URL/etc). `imageKey` is a subkey from
// deriveSubkey(rawBits, "mauso-image-key"); nothing here manages caching
// that key itself, same as saveConversation doesn't manage the
// conversation key's lifecycle.

export async function storeImage(imageKey, id, bytes, contentType) {
  const db = await openDB();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, imageKey, bytes);
  const record = { id, contentType, iv: bufToB64(iv), ciphertext: bufToB64(ciphertext), createdAt: Date.now() };
  await reqToPromise(tx(db, "images", "readwrite").put(record));
  return record;
}

// Returns {bytes: Uint8Array, contentType} or null if no image has that id.
// Throws if imageKey is wrong (AES-GCM's auth tag check fails), same as
// loadConversation.
export async function loadImage(imageKey, id) {
  const db = await openDB();
  const record = await reqToPromise(tx(db, "images", "readonly").get(id));
  if (!record) return null;
  const iv = new Uint8Array(b64ToBuf(record.iv));
  const plainBuf = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, imageKey, b64ToBuf(record.ciphertext));
  return { bytes: new Uint8Array(plainBuf), contentType: record.contentType };
}

export async function deleteImage(id) {
  const db = await openDB();
  await reqToPromise(tx(db, "images", "readwrite").delete(id));
}

export async function listImageIds() {
  const db = await openDB();
  const records = await reqToPromise(tx(db, "images", "readonly").getAll());
  return records.map((r) => r.id);
}

// --- Browser-only notes storage ("notes" store) --------------------------
//
// Structured JSON in/out (unlike storeImage's raw bytes) -- mirrors
// saveConversation/loadConversation's shape. `notesKey` is a subkey from
// deriveSubkey(rawBits, "mauso-notes-key"); nothing here manages caching
// that key itself, same as storeImage doesn't manage imageKey's lifecycle.
// `note` is a plain object, e.g. {id, title, content_markdown, tags,
// created_at, updated_at} -- this module doesn't care about its shape
// beyond requiring an `id` field to key the record.

export async function storeNote(notesKey, note) {
  const db = await openDB();
  const { iv, ciphertext } = await encryptJSON(notesKey, note);
  const record = { id: note.id, updatedAt: Date.now(), iv, ciphertext };
  await reqToPromise(tx(db, "notes", "readwrite").put(record));
  return record;
}

// Returns the decrypted note object, or null if no note has that id.
// Throws if notesKey is wrong (AES-GCM's auth tag check fails), same as
// loadImage.
export async function loadNote(notesKey, id) {
  const db = await openDB();
  const record = await reqToPromise(tx(db, "notes", "readonly").get(id));
  if (!record) return null;
  return decryptJSON(notesKey, record.iv, record.ciphertext);
}

export async function deleteNote(id) {
  const db = await openDB();
  await reqToPromise(tx(db, "notes", "readwrite").delete(id));
}

// Decrypts and returns every stored note, most recently updated first
// (by this store's own updatedAt, not the plaintext note's own timestamp).
export async function listNoteRecords(notesKey) {
  const db = await openDB();
  const records = await reqToPromise(tx(db, "notes", "readonly").getAll());
  records.sort((a, b) => b.updatedAt - a.updatedAt);
  return Promise.all(records.map((r) => decryptJSON(notesKey, r.iv, r.ciphertext)));
}

// --- Browser-only RAG document storage ("documents" + "doc_chunks") ------
//
// Mirrors storeNote/loadNote's shape, split across two stores because a
// document has many chunks. `docsKey` is a subkey from
// deriveSubkey(rawBits, "mauso-docs-key"); nothing here manages caching
// that key itself, same as storeNote doesn't manage notesKey's lifecycle.
// `document` is a plain object, e.g. {id, filename, size_bytes, status,
// error, created_at} -- this module doesn't care about its shape beyond
// requiring an `id` field to key the record. `chunk` is e.g. {id,
// document_id, chunk_index, text, vector}.

export async function storeDocument(docsKey, document) {
  const db = await openDB();
  const { iv, ciphertext } = await encryptJSON(docsKey, document);
  const record = { id: document.id, updatedAt: Date.now(), iv, ciphertext };
  await reqToPromise(tx(db, "documents", "readwrite").put(record));
  return record;
}

// Returns the decrypted document object, or null if no document has that id.
// Throws if docsKey is wrong (AES-GCM's auth tag check fails), same as
// loadNote.
export async function loadDocument(docsKey, id) {
  const db = await openDB();
  const record = await reqToPromise(tx(db, "documents", "readonly").get(id));
  if (!record) return null;
  return decryptJSON(docsKey, record.iv, record.ciphertext);
}

export async function deleteDocument(id) {
  const db = await openDB();
  await reqToPromise(tx(db, "documents", "readwrite").delete(id));
}

// Decrypts and returns every stored document, most recently updated first.
export async function listDocumentRecords(docsKey) {
  const db = await openDB();
  const records = await reqToPromise(tx(db, "documents", "readonly").getAll());
  records.sort((a, b) => b.updatedAt - a.updatedAt);
  return Promise.all(records.map((r) => decryptJSON(docsKey, r.iv, r.ciphertext)));
}

export async function storeDocChunk(docsKey, chunk) {
  const db = await openDB();
  const { iv, ciphertext } = await encryptJSON(docsKey, chunk);
  const record = { id: chunk.id, documentId: chunk.document_id, iv, ciphertext };
  await reqToPromise(tx(db, "doc_chunks", "readwrite").put(record));
  return record;
}

// Decrypts and returns every chunk belonging to the given document id, in
// no particular order (callers sort by chunk_index if needed).
export async function listDocChunksForDocument(docsKey, documentId) {
  const db = await openDB();
  const all = await reqToPromise(tx(db, "doc_chunks", "readonly").getAll());
  const matches = all.filter((r) => r.documentId === documentId);
  return Promise.all(matches.map((r) => decryptJSON(docsKey, r.iv, r.ciphertext)));
}

export async function deleteDocChunksForDocument(documentId) {
  const db = await openDB();
  const all = await reqToPromise(tx(db, "doc_chunks", "readonly").getAll());
  const store = tx(db, "doc_chunks", "readwrite");
  await Promise.all(
    all.filter((r) => r.documentId === documentId).map((r) => reqToPromise(store.delete(r.id))),
  );
}
