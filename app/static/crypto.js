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
const DB_VERSION = 1;
const SESSION_KEY_STORAGE = "mauso_session_key_bits";

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
  if (existing) return b64ToBuf(existing.value);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  await reqToPromise(tx(db, "meta", "readwrite").put({ key: "salt", value: bufToB64(salt) }));
  return salt.buffer;
}

export async function hasExistingSalt() {
  const db = await openDB();
  const existing = await reqToPromise(tx(db, "meta", "readonly").get("salt"));
  return !!existing;
}

// Extractable on purpose -- immediately after deriving, the caller caches
// this key for the session (see cacheKeyForSession). Everywhere else that
// hands out a key (restoreKeyFromSession) re-imports it non-extractable.
export async function deriveKey(passphrase, saltBuf) {
  const enc = new TextEncoder();
  const baseKey = await crypto.subtle.importKey(
    "raw", enc.encode(passphrase), "PBKDF2", false, ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: saltBuf, iterations: 250000, hash: "SHA-256" },
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
