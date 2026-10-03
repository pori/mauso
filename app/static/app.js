import * as Crypto from "./crypto.js";
import { renderMarkdown } from "./markdown.js";
import { searchConversations } from "./search.js";

let sessionKey = null;
let currentConvo = null; // { id, title, messages: [{role, content, kind?}], activeDocumentIds: [], model, profileId }
let currentSearchQuery = ""; // sidebar conversation search -- see refreshConversationList
let availableFiles = [];
let availableModels = []; // [{id, vision}, ...] from /api/models
let modelVisionSupport = new Map(); // model id -> bool, derived from availableModels on each refresh
let availableProfiles = []; // [{ id, name, model, system_prompt }]
let defaultModel = ""; // the Settings-page global default
let pendingImageAttachments = []; // [{ id, url, source }] -- filled as images are attached via the attach button
let imageKey = null; // HKDF subkey for the "images" IndexedDB store, derived once in boot()
let activeBlobUrls = []; // blob: URLs for images currently rendered in the transcript -- revoked in renderMessages()
let mentionBlobUrls = []; // blob: URLs for the @image mention dropdown's thumbnails -- revoked in hideMentionDropdown()

// Whether streaming/new messages should auto-scroll the message pane to the
// bottom. Starts true; goes false the moment the user scrolls away from the
// bottom (see the "messages" scroll listener in boot()), so a reply that's
// still streaming in doesn't keep yanking the view back down while they're
// reading scrollback. Comes back true once they scroll back to the bottom
// themselves, or the moment they send a new message / open a conversation.
let autoScroll = true;
const SCROLL_BOTTOM_SLOP = 48; // px -- treat "close enough" to bottom as "at bottom"

const el = (id) => document.getElementById(id);

function isNearBottom(box) {
  return box.scrollHeight - box.scrollTop - box.clientHeight < SCROLL_BOTTOM_SLOP;
}

// Scrolls to the bottom only if the user hasn't scrolled away from it --
// call this everywhere a message/token is appended. See forceScrollToBottom
// for the "always scroll" variant used when the user actively does something
// (sends a message, opens a conversation) that should snap back down.
function maybeScrollToBottom() {
  if (!autoScroll) return;
  const box = el("messages");
  box.scrollTop = box.scrollHeight;
}

function forceScrollToBottom() {
  autoScroll = true;
  const box = el("messages");
  box.scrollTop = box.scrollHeight;
  el("jump-to-bottom-btn").hidden = true;
}

const COPY_SVG = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
const EDIT_SVG = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>';
const CHECK_SVG = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
const KEBAB_SVG = '<svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor"><circle cx="12" cy="5" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="12" cy="19" r="1.6"/></svg>';
const DOWNLOAD_SVG = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>';
const TRASH_SVG = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>';
const RETRY_SVG = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>';

function formatTimestamp(ts) {
  if (!ts) return "";
  return new Date(ts).toLocaleString(undefined, {
    month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  });
}

// Wall-clock elapsed time, shown next to an AI reply's model name and next
// to a generated/edited image -- timed client-side (see runAgentTurn/
// handleEvent) since the server never buffers a turn to measure it itself.
function formatElapsed(ms) {
  if (ms == null) return "";
  const s = ms / 1000;
  if (s < 10) return `${s.toFixed(1)}s`;
  if (s < 60) return `${Math.round(s)}s`;
  return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
}

// The model-label line above an assistant reply -- model name, plus elapsed
// time once the turn has finished (m.elapsedMs is only set at that point).
function modelLabelText(m) {
  const model = m.model || "";
  const elapsed = formatElapsed(m.elapsedMs);
  if (model && elapsed) return `${model} · ${elapsed}`;
  return model || elapsed;
}

// Tapping a bubble opens its own actions row (see renderUserMessage); this
// closes any OTHER open one when the tap lands outside it. Runs on every
// click regardless of what else is on screen, so it belongs at module
// scope, not inside boot(). Action buttons call stopPropagation() so
// clicking Copy/Edit never reaches here.
//
// Listens on "pointerdown", not "click": iOS Safari only synthesizes a
// click event for a tap when the tapped element (or an ancestor) has its
// own click handler or cursor:pointer -- a tap that lands on an inert
// element (the plain message background, an assistant message div, etc.)
// otherwise never fires a click at document level, so tap-outside-to-close
// silently never triggered there. pointerdown fires for any tap regardless.
document.addEventListener("pointerdown", (e) => {
  document.querySelectorAll(".msg-wrap.expanded").forEach((wrap) => {
    if (!wrap.contains(e.target)) wrap.classList.remove("expanded");
  });
  document.querySelectorAll(".convo-item-row.menu-open").forEach((row) => {
    if (!row.contains(e.target)) row.classList.remove("menu-open");
  });
});

// ---------- Unlock flow ----------

async function init() {
  const restored = await Crypto.restoreKeyFromSession();
  if (restored) {
    sessionKey = restored;
    el("unlock-overlay").style.display = "none";
    await boot();
    return;
  }
  await initUnlock();
}

async function initUnlock() {
  const hasSalt = await Crypto.hasExistingSalt();
  el("unlock-mode-label").textContent = hasSalt
    ? "Enter your passphrase to unlock your conversations."
    : "Choose a passphrase to encrypt your conversations. Write it down -- it is never stored anywhere and cannot be recovered.";
  el("unlock-confirm-row").style.display = hasSalt ? "none" : "block";
  el("unlock-form").addEventListener("submit", onUnlockSubmit);
}

async function onUnlockSubmit(e) {
  e.preventDefault();
  const passphrase = el("passphrase-input").value;
  const hasSalt = await Crypto.hasExistingSalt();
  if (!hasSalt) {
    const confirm = el("passphrase-confirm-input").value;
    if (passphrase.length < 8) {
      showUnlockError("Use at least 8 characters.");
      return;
    }
    if (passphrase !== confirm) {
      showUnlockError("Passphrases don't match.");
      return;
    }
  }
  const salt = await Crypto.getOrCreateSalt();
  const iterations = await Crypto.getKdfIterations();
  const derived = await Crypto.deriveKey(passphrase, salt, iterations);
  const verdict = await Crypto.verifyPassphrase(derived);
  if (verdict === false) {
    showUnlockError("Wrong passphrase.");
    return;
  }
  await Crypto.cacheKeyForSession(derived);
  sessionKey = await Crypto.restoreKeyFromSession();
  el("unlock-overlay").style.display = "none";
  await boot();
}

function lock() {
  Crypto.clearSessionKey();
  location.reload();
}

function showUnlockError(msg) {
  const box = el("unlock-error");
  box.textContent = msg;
  box.style.display = "block";
}

// ---------- URL <-> conversation sync ----------
//
// The chat page is server-rendered (no SPA router), but which conversation
// is open lives only in JS memory unless we put it in the URL too --
// otherwise a refresh always falls back to "most recent", losing your place.
// `?c=<id>` on `/` carries the open conversation; pushState on every
// user-initiated switch (new/open) makes browser back/forward step through
// conversations, replaceState on boot/popstate-driven loads keeps those from
// piling up spurious history entries.

function convoUrl(id) {
  return `${location.pathname}?c=${encodeURIComponent(id)}`;
}

function getConvoIdFromUrl() {
  return new URLSearchParams(location.search).get("c");
}

function syncUrl(id, push) {
  const method = push ? "pushState" : "replaceState";
  history[method]({ convoId: id }, "", convoUrl(id));
}

window.addEventListener("popstate", () => {
  const id = getConvoIdFromUrl();
  if (id && (!currentConvo || id !== currentConvo.id)) {
    openConversation(id, { push: false });
  }
});

// ---------- Boot ----------

async function boot() {
  imageKey = await Crypto.deriveSubkey(Crypto.getSessionKeyRawBits(), "mauso-image-key");
  await migrateImagesIfNeeded();
  reconcileRenderJobs(); // not awaited -- covers reload-after-navigating-away, see #10
  await refreshFiles();
  await refreshModels();
  await refreshProfiles();
  await refreshConversationList();
  const forceNew = new URLSearchParams(location.search).get("new") === "1";
  const urlId = getConvoIdFromUrl();
  const records = await Crypto.listConversationRecords();
  if (!forceNew && urlId && records.some((r) => r.id === urlId)) {
    await openConversation(urlId, { push: false });
  } else if (!forceNew && records.length > 0) {
    await openConversation(records[0].id, { push: false });
  } else {
    // Also reached via the Files/Settings pages' "+ New conversation"
    // link (`/?new=1`) -- see sidebar_history.js.
    await newConversation({ push: false });
  }
  el("send-form").addEventListener("submit", onSend);
  el("send-btn").addEventListener("click", () => {
    if (activeAbortController) activeAbortController.abort();
  });
  el("new-convo-btn").addEventListener("click", () => { newConversation(); window.mausoSetSidebarOpen(false); });
  el("convo-search-input").addEventListener("input", () => {
    currentSearchQuery = el("convo-search-input").value;
    refreshConversationList();
  });
  el("attach-input").addEventListener("change", onAttachChange);
  el("message-input").addEventListener("paste", onComposerPaste);
  el("message-input").addEventListener("input", onComposerInput);
  el("message-input").addEventListener("keydown", onComposerKeydown);
  el("message-input").addEventListener("blur", hideMentionDropdown);
  el("lock-btn").addEventListener("click", lock);
  el("messages").addEventListener("scroll", () => {
    autoScroll = isNearBottom(el("messages"));
    el("jump-to-bottom-btn").hidden = autoScroll;
  });
  el("jump-to-bottom-btn").addEventListener("click", forceScrollToBottom);
  el("model-picker").addEventListener("change", () => {
    if (!currentConvo) return;
    currentConvo.model = el("model-picker").value;
    persistCurrentConvo();
    updateAttachStatus();
  });
  el("profile-picker").addEventListener("change", () => {
    if (!currentConvo) return;
    const id = el("profile-picker").value;
    currentConvo.profileId = id ? Number(id) : null;
    // A profile can pin a model -- adopt it, but leave the model picker
    // free to be overridden afterward like any other conversation.
    const profile = availableProfiles.find((p) => p.id === currentConvo.profileId);
    if (profile && profile.model) {
      currentConvo.model = profile.model;
      populateModelPicker();
    }
    persistCurrentConvo();
  });
}

// One-time, lazy migration (#11 stage 2): before this shipped, every image
// lived server-side under an integer id, referenced from a conversation
// record's image_url. Images now live only in the browser, so this walks
// every persisted conversation once, pulls any not-yet-local legacy image's
// bytes in via the still-available (read-only) GET route, and stores them
// under their existing id in the "images" store. Conversation records
// themselves are never rewritten -- image_url stays as a harmless fallback
// field forever; resolveImageBytes() below tries IndexedDB first and only
// falls back to fetching it if a lookup misses, so nothing here needs to
// correct outgoing references. Guarded by Crypto.hasImagesMigrated() so
// this only ever runs once per vault, mirroring getOrCreateSalt's backfill
// idiom in crypto.js.
async function migrateImagesIfNeeded() {
  if (await Crypto.hasImagesMigrated()) return;
  const alreadyLocal = new Set(await Crypto.listImageIds());
  const records = await Crypto.listConversationRecords();
  for (const r of records) {
    let convo;
    try {
      convo = await Crypto.loadConversation(sessionKey, r.id);
    } catch {
      continue; // a record this passphrase can't decrypt isn't this migration's problem
    }
    for (const m of convo.messages || []) {
      if (m.kind !== "image" || !m.image_url || alreadyLocal.has(m.image_id)) continue;
      try {
        const resp = await fetch(m.image_url);
        if (!resp.ok) continue;
        const contentType = resp.headers.get("content-type") || "image/png";
        const bytes = new Uint8Array(await resp.arrayBuffer());
        await Crypto.storeImage(imageKey, m.image_id, bytes, contentType);
        alreadyLocal.add(m.image_id);
      } catch {
        // Best-effort -- one unreachable/already-gone legacy image
        // shouldn't block the rest of the pass or the mark-done step below.
      }
    }
  }
  await Crypto.markImagesMigrated();
}

// Resolves one pending render job against the server (#10). Returns
// "pending" (still queued/running, or the request itself failed -- try
// again later) or {status: "succeeded", bytes, contentType} /
// {status: "failed", error}. Deletes the server-side job row once it's
// been absorbed either way -- a 404 (e.g. a server restart swept it, or
// it was never actually created) counts as "failed" with a clear reason
// rather than leaving the placeholder stuck pending forever.
async function pollRenderJob(jobId) {
  let resp;
  try {
    resp = await fetch(`/api/render-jobs/${jobId}`);
  } catch {
    return "pending";
  }
  if (resp.status === 404) {
    return { status: "failed", error: "This render's record is gone (the server may have restarted)." };
  }
  if (!resp.ok) return "pending";
  const body = await resp.json();
  if (body.status === "succeeded") {
    fetch(`/api/render-jobs/${jobId}`, { method: "DELETE" }).catch(() => {});
    return { status: "succeeded", bytes: new Uint8Array(Crypto.b64ToBuf(body.image_b64)), contentType: body.content_type || "image/png" };
  }
  if (body.status === "failed") {
    fetch(`/api/render-jobs/${jobId}`, { method: "DELETE" }).catch(() => {});
    return { status: "failed", error: body.error || "The render failed." };
  }
  return "pending"; // queued | running
}

// Walks every persisted conversation (not just the open one -- the user
// may have switched away entirely) for a render still marked "pending"
// and finds out what actually happened server-side. Run once on boot
// (reload-after-navigating-away) and on visibilitychange -> visible;
// re-schedules itself every ~5s while anything is still genuinely pending
// and the page is visible, so a render that finishes while the tab is
// back in the foreground shows up without needing another reload.
async function reconcileRenderJobs() {
  const records = await Crypto.listConversationRecords();
  let anyStillPending = false;
  for (const r of records) {
    let convo;
    try {
      convo = await Crypto.loadConversation(sessionKey, r.id);
    } catch {
      continue;
    }
    const pending = (convo.messages || []).filter((m) => m.kind === "image" && m.status === "pending");
    if (!pending.length) continue;
    let changed = false;
    for (const m of pending) {
      const outcome = await pollRenderJob(m.jobId);
      if (outcome === "pending") {
        anyStillPending = true;
        continue;
      }
      changed = true;
      if (outcome.status === "succeeded") {
        await Crypto.storeImage(imageKey, m.jobId, outcome.bytes, outcome.contentType);
        // "recovered" (not a plain resolved state) -- this turn's SSE
        // connection actually dropped before the result arrived, unlike
        // the live tool_result path above, so renderMessage adds a note.
        m.status = "recovered";
        m.image_id = m.jobId;
      } else {
        m.status = "failed";
        m.error = outcome.error;
      }
    }
    if (changed) {
      await Crypto.saveConversation(sessionKey, r.id, convo);
      if (currentConvo && currentConvo.id === r.id) {
        currentConvo = convo;
        renderMessages();
      }
    }
  }
  if (anyStillPending && document.visibilityState === "visible") {
    setTimeout(reconcileRenderJobs, 5000);
  }
}

// Populates the model picker from the configured endpoint's /models list
// (falling back to just the global default if that call fails, e.g. the
// endpoint is unreachable) plus whatever model the current conversation is
// already pinned to, even if it's since disappeared from that list.
async function refreshModels() {
  try {
    const settingsData = await (await fetch("/api/settings")).json();
    defaultModel = settingsData.model || "";
  } catch {
    defaultModel = "";
  }
  try {
    const modelsData = await (await fetch("/api/models")).json();
    availableModels = modelsData.models || [];
  } catch {
    availableModels = [];
  }
  modelVisionSupport = new Map(availableModels.map((m) => [m.id, !!m.vision]));
  populateModelPicker();
}

// A model missing from modelVisionSupport (not in the last /api/models
// response -- e.g. a conversation pinned to a model that's since
// disappeared from the endpoint) is treated as non-vision, the safer
// default: better to silently fall back to a text placeholder than risk
// the endpoint erroring on an image_url part it doesn't understand.
function modelSupportsVision(modelId) {
  return modelVisionSupport.get(modelId) === true;
}

function populateModelPicker() {
  const select = el("model-picker");
  select.innerHTML = "";
  const options = new Set(availableModels.map((m) => m.id));
  if (defaultModel) options.add(defaultModel);
  if (currentConvo && currentConvo.model) options.add(currentConvo.model);
  for (const m of options) {
    const opt = document.createElement("option");
    opt.value = m;
    opt.textContent = m === defaultModel ? `${m} (default)` : m;
    select.appendChild(opt);
  }
  select.value = (currentConvo && currentConvo.model) || defaultModel || "";
}

async function refreshProfiles() {
  try {
    availableProfiles = await (await fetch("/api/profiles")).json();
  } catch {
    availableProfiles = [];
  }
  populateProfilePicker();
}

function populateProfilePicker() {
  const select = el("profile-picker");
  select.innerHTML = "";
  const none = document.createElement("option");
  none.value = ""; none.textContent = "No profile";
  select.appendChild(none);
  for (const p of availableProfiles) {
    const opt = document.createElement("option");
    opt.value = p.id;
    opt.textContent = p.name;
    select.appendChild(opt);
  }
  select.value = (currentConvo && currentConvo.profileId) || "";
}

async function refreshFiles() {
  const resp = await fetch("/api/files");
  availableFiles = await resp.json();
  const box = el("active-files");
  box.innerHTML = "";
  if (availableFiles.length === 0) {
    box.innerHTML = '<p class="hint">No files uploaded yet -- see the Files page.</p>';
    return;
  }
  for (const f of availableFiles) {
    const label = document.createElement("label");
    label.className = "file-toggle";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.value = f.id;
    checkbox.disabled = f.status !== "indexed";
    checkbox.checked = currentConvo && currentConvo.activeDocumentIds.includes(f.id);
    checkbox.addEventListener("change", () => {
      if (!currentConvo) return;
      const id = f.id;
      if (checkbox.checked) {
        if (!currentConvo.activeDocumentIds.includes(id)) currentConvo.activeDocumentIds.push(id);
      } else {
        currentConvo.activeDocumentIds = currentConvo.activeDocumentIds.filter((x) => x !== id);
      }
      persistCurrentConvo();
    });
    label.appendChild(checkbox);
    label.append(` ${f.filename} ${f.status !== "indexed" ? `(${f.status})` : ""}`);
    box.appendChild(label);
  }
}

// The search box above the list filters against decrypted conversation
// content entirely client-side (see search.js) -- decrypt every record once
// up front (same Crypto.loadConversation() call this function always made,
// per row, to show titles) so both the title-display and the search-match
// passes below reuse it rather than decrypting twice.
async function refreshConversationList() {
  const records = await Crypto.listConversationRecords();
  const decrypted = await Promise.all(
    records.map(async (r) => ({ record: r, data: await Crypto.loadConversation(sessionKey, r.id).catch(() => null) })),
  );

  const query = currentSearchQuery.trim();
  let snippetById = null;
  let visible = decrypted;
  if (query) {
    const results = searchConversations(
      decrypted.filter((d) => d.data).map((d) => ({ id: d.record.id, title: d.data.title, messages: d.data.messages })),
      query,
    );
    snippetById = new Map(results.map((res) => [res.id, res.snippet]));
    visible = decrypted.filter((d) => snippetById.has(d.record.id));
  }

  const list = el("convo-list");
  list.innerHTML = "";
  if (query && visible.length === 0) {
    list.innerHTML = '<p class="hint">No matching conversations.</p>';
    return;
  }

  for (const { record: r, data } of visible) {
    const row = document.createElement("div");
    row.className = "convo-item-row";

    const item = document.createElement("div");
    item.className = "convo-item" + (currentConvo && currentConvo.id === r.id ? " active" : "");
    item.textContent = data ? data.title || "Untitled" : "(undecryptable)";
    item.addEventListener("click", () => { openConversation(r.id); window.mausoSetSidebarOpen(false); });
    row.appendChild(item);

    const menuBtn = document.createElement("button");
    menuBtn.type = "button";
    menuBtn.className = "convo-menu-btn";
    menuBtn.title = "More";
    menuBtn.innerHTML = KEBAB_SVG;
    menuBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const wasOpen = row.classList.contains("menu-open");
      document.querySelectorAll(".convo-item-row.menu-open").forEach((r2) => r2.classList.remove("menu-open"));
      if (!wasOpen) row.classList.add("menu-open");
    });
    row.appendChild(menuBtn);

    if (data) {
      const menu = document.createElement("div");
      menu.className = "convo-menu";
      menu.appendChild(convoMenuAction(DOWNLOAD_SVG, "Download", () => downloadConversation(r.id)));
      menu.appendChild(convoMenuAction(EDIT_SVG, "Rename", () => renameConversation(r.id, item)));
      menu.appendChild(convoMenuAction(COPY_SVG, "Clone", () => cloneConversation(r.id)));
      menu.appendChild(convoMenuAction(TRASH_SVG, "Delete", () => deleteConversationFlow(r.id), true));
      row.appendChild(menu);
    }

    list.appendChild(row);

    if (snippetById && snippetById.has(r.id)) {
      const snippet = document.createElement("div");
      snippet.className = "convo-search-snippet";
      snippet.textContent = snippetById.get(r.id);
      list.appendChild(snippet);
    }
  }
}

function convoMenuAction(svg, label, onClick, danger = false) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "convo-menu-item" + (danger ? " danger" : "");
  btn.innerHTML = `${svg}<span>${label}</span>`;
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    document.querySelectorAll(".convo-item-row.menu-open").forEach((r) => r.classList.remove("menu-open"));
    onClick();
  });
  return btn;
}

// ---------- Per-conversation menu actions ----------

async function downloadConversation(id) {
  const data = await Crypto.loadConversation(sessionKey, id);
  if (!data) return;
  const payload = { title: data.title, model: data.model, profileId: data.profileId || null, messages: data.messages };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${(data.title || "conversation").replace(/[^\w-]+/g, "_").slice(0, 60)}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// Inline-edits the sidebar row itself (swaps the div for a text input)
// rather than a native prompt(), matching how message editing works.
async function renameConversation(id, itemEl) {
  const data = await Crypto.loadConversation(sessionKey, id);
  if (!data) return;
  const input = document.createElement("input");
  input.type = "text";
  input.className = "convo-rename-input";
  input.value = data.title || "";
  itemEl.replaceWith(input);
  input.focus();
  input.select();

  let done = false;
  const commit = async () => {
    if (done) return;
    done = true;
    const newTitle = input.value.trim() || "Untitled";
    if (newTitle !== data.title) {
      data.title = newTitle;
      await Crypto.saveConversation(sessionKey, id, data);
      if (currentConvo && currentConvo.id === id) {
        currentConvo.title = newTitle;
        updateChatTitle();
      }
    }
    await refreshConversationList();
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); input.blur(); }
    if (e.key === "Escape") { e.preventDefault(); done = true; refreshConversationList(); }
  });
  input.addEventListener("blur", commit);
}

async function cloneConversation(id) {
  const data = await Crypto.loadConversation(sessionKey, id);
  if (!data) return;
  const newId = Crypto.newConversationId();
  const cloned = {
    title: `${data.title || "Untitled"} (copy)`,
    messages: JSON.parse(JSON.stringify(data.messages)),
    activeDocumentIds: [...(data.activeDocumentIds || [])],
    model: data.model,
    profileId: data.profileId || null,
  };
  await Crypto.saveConversation(sessionKey, newId, cloned);
  await openConversation(newId);
}

async function deleteConversationFlow(id) {
  if (!confirm("Delete this conversation? This can't be undone.")) return;
  await Crypto.deleteConversation(id);
  if (currentConvo && currentConvo.id === id) {
    const records = await Crypto.listConversationRecords();
    if (records.length > 0) {
      await openConversation(records[0].id);
    } else {
      await newConversation();
    }
  } else {
    await refreshConversationList();
  }
}

// ---------- Conversation management ----------

async function newConversation({ push = true } = {}) {
  currentConvo = {
    id: Crypto.newConversationId(), title: "New conversation",
    messages: [], activeDocumentIds: [], model: defaultModel, profileId: null,
  };
  syncUrl(currentConvo.id, push);
  renderMessages();
  populateModelPicker();
  populateProfilePicker();
  updateChatTitle();
  await refreshConversationList();
  await refreshFiles();
}

async function openConversation(id, { push = true } = {}) {
  const data = await Crypto.loadConversation(sessionKey, id);
  if (!data) return;
  currentConvo = { id, ...data };
  syncUrl(id, push);
  renderMessages();
  populateModelPicker();
  populateProfilePicker();
  updateChatTitle();
  await refreshConversationList();
  await refreshFiles();
}

function updateChatTitle() {
  const titleEl = el("chat-title");
  if (titleEl) titleEl.textContent = currentConvo ? currentConvo.title || "New conversation" : "";
}

async function persistCurrentConvo() {
  if (!currentConvo) return;
  // Don't create a conversation record until it has at least one message --
  // otherwise every "+ New conversation" click (including the implicit one
  // at boot / after deleting the last conversation) leaves a dangling empty
  // "New conversation" entry in IndexedDB that the user has to notice and
  // delete by hand.
  if (currentConvo.messages.length === 0) return;
  await Crypto.saveConversation(sessionKey, currentConvo.id, {
    title: currentConvo.title,
    messages: currentConvo.messages,
    activeDocumentIds: currentConvo.activeDocumentIds,
    model: currentConvo.model,
    profileId: currentConvo.profileId || null,
  });
}

function deriveTitle() {
  const firstUser = currentConvo.messages.find((m) => m.role === "user");
  if (firstUser) currentConvo.title = firstUser.content.slice(0, 60);
}

// ---------- Image byte resolution (#11 stage 2) ----------
//
// Images now live only in IndexedDB ("images" store, see crypto.js). Every
// display/vision/attach site resolves bytes through resolveImageBytes()
// below: try the local store first, and only fall back to fetching
// legacyUrl (the pre-#11-stage-2 server endpoint, still live read-only) if
// that misses -- i.e. for an image this vault hasn't migrated/stored
// locally yet. New images never get an image_url at all, so for them the
// local lookup is the only path.

async function resolveImageBytes(imageId, legacyUrl) {
  const local = await Crypto.loadImage(imageKey, imageId);
  if (local) return local;
  if (!legacyUrl) return null;
  try {
    const resp = await fetch(legacyUrl);
    if (!resp.ok) return null;
    const contentType = resp.headers.get("content-type") || "image/png";
    const bytes = new Uint8Array(await resp.arrayBuffer());
    return { bytes, contentType };
  } catch {
    return null;
  }
}

function trackedBlobUrl(bytes, contentType) {
  const url = URL.createObjectURL(new Blob([bytes], { type: contentType }));
  activeBlobUrls.push(url);
  return url;
}

function revokeTrackedBlobUrls() {
  for (const url of activeBlobUrls) URL.revokeObjectURL(url);
  activeBlobUrls = [];
}

function trackedMentionBlobUrl(bytes, contentType) {
  const url = URL.createObjectURL(new Blob([bytes], { type: contentType }));
  mentionBlobUrls.push(url);
  return url;
}

function revokeMentionBlobUrls() {
  for (const url of mentionBlobUrls) URL.revokeObjectURL(url);
  mentionBlobUrls = [];
}

// ---------- Rendering ----------

function renderMessages() {
  // Every call here means the previously-rendered transcript's images (if
  // any) are about to be thrown away -- revoke their blob: URLs before
  // clearing the DOM, not after, so nothing can still reference a revoked
  // one. Covers every conversation-switch path (newConversation,
  // openConversation, retryMessage all funnel through this).
  revokeTrackedBlobUrls();
  const box = el("messages");
  box.innerHTML = "";
  for (const m of currentConvo.messages) box.appendChild(renderMessage(m));
  forceScrollToBottom();
}

function renderMessage(m) {
  if (m.role === "user" && !m.kind) return renderUserMessage(m);
  if (m.role === "assistant" && !m.kind) return renderAssistantMessage(m);

  const div = document.createElement("div");
  div.className = `msg msg-${m.role}`;
  if (m.kind === "note") {
    div.className += " msg-note";
    const h = document.createElement("strong");
    h.textContent = `📝 ${m.title}`;
    const body = document.createElement("pre");
    body.textContent = m.content;
    div.appendChild(h);
    div.appendChild(body);
  } else if (m.kind === "image") {
    div.className += " msg-image";
    // Set whenever a render went through the resumable-job path (#10),
    // regardless of its current status -- lets updateImageMessageByJobId
    // find this exact node again later to patch it in place.
    if (m.jobId) div.dataset.jobId = m.jobId;

    if (m.status === "pending") {
      div.className += " msg-image-pending";
      const p = document.createElement("div");
      p.className = "msg-image-caption";
      p.textContent = `⏳ ${m.source === "edited" ? "Editing" : "Generating"} image${m.prompt ? ` (${m.prompt})` : ""}...`;
      div.appendChild(p);
      return div;
    }
    if (m.status === "failed") {
      div.className += " msg-image-failed";
      const p = document.createElement("div");
      p.className = "msg-image-caption";
      p.textContent = `⚠️ ${m.source === "edited" ? "Edit" : "Generation"} failed: ${m.error || "unknown error"}`;
      const retryBtn = document.createElement("button");
      retryBtn.type = "button";
      retryBtn.className = "msg-image-retry-btn";
      retryBtn.textContent = "Retry";
      retryBtn.addEventListener("click", () => retryImageMessage(m));
      div.append(p, retryBtn);
      return div;
    }

    const p = document.createElement("div");
    p.className = "msg-image-caption";
    const label = m.source === "upload" ? "Uploaded image"
      : m.source === "url" ? "Image from the web"
      : m.prompt || "Image";
    const idSpan = document.createElement("span");
    idSpan.className = "hint";
    const elapsed = formatElapsed(m.elapsedMs);
    // "recovered" means the turn that started this render got interrupted
    // (tab backgrounded/closed) before the result came back over SSE --
    // reconcileRenderJobs() picked it up afterward. The image itself made
    // it; any text the model would have said about it in the same turn
    // didn't, and isn't reconstructed -- see #10's accepted scope.
    const recoveredNote = m.status === "recovered" ? " (response interrupted — image recovered)" : "";
    idSpan.textContent = ` (id ${m.image_id})${elapsed ? ` · ${elapsed}` : ""}${recoveredNote}`;
    p.textContent = `🖼 ${label}`;
    p.appendChild(idSpan);
    const img = document.createElement("img");
    img.src = LOADING_THUMB_SRC;
    resolveImageBytes(m.image_id, m.image_url).then((resolved) => {
      if (resolved) img.src = trackedBlobUrl(resolved.bytes, resolved.contentType);
    });
    div.appendChild(p);
    const tag = imageTagForId(m.image_id);
    if (tag) {
      const wrap = document.createElement("div");
      wrap.className = "msg-image-wrap";
      const badge = document.createElement("button");
      badge.type = "button";
      badge.className = "msg-image-tag";
      badge.textContent = tag;
      badge.title = `Reference this image as @${tag} in your next message`;
      badge.addEventListener("click", () => insertMentionAtCursor(tag));
      wrap.append(img, badge);
      div.appendChild(wrap);
    } else {
      div.appendChild(img);
    }
  }
  return div;
}

// Removes a failed render's placeholder and pre-fills the composer with a
// retry instruction for the user to review and send themselves, rather
// than silently re-triggering a new LLM/ComfyUI call on their behalf --
// tools are only ever invoked by the model deciding to call them, there's
// no direct "run this tool again" path, and auto-resending without
// confirmation would spend a turn/render the user didn't explicitly ask
// for again.
function retryImageMessage(m) {
  currentConvo.messages = currentConvo.messages.filter((msg) => msg !== m);
  renderMessages();
  persistCurrentConvo();
  const input = el("message-input");
  input.value = m.source === "edited"
    ? `Please retry editing that image: ${m.prompt}`
    : `Please retry generating that image: ${m.prompt}`;
  autoResizeComposerInput();
  input.focus();
}

// Finds the still-in-currentConvo image message with this jobId (any
// status), lets `mutate` change it in place, then patches the already-
// rendered DOM node (found via the data-job-id set above) to match --
// without a full renderMessages() pass. Used by the live tool_result path
// (connection survived) where other turn content may still be streaming
// in concurrently; reconcileRenderJobs() below updates a *different*
// (possibly not-open) conversation's record directly instead, since it
// has no live DOM to patch.
function updateImageMessageByJobId(jobId, mutate) {
  const idx = currentConvo.messages.findIndex((msg) => msg.kind === "image" && msg.jobId === jobId);
  if (idx === -1) return null;
  const msg = currentConvo.messages[idx];
  mutate(msg);
  const oldNode = el("messages").querySelector(`[data-job-id="${jobId}"]`);
  if (oldNode) oldNode.replaceWith(renderMessage(msg));
  return msg;
}

// ---------- Image @mentions ----------
//
// Every image in the conversation (uploaded, pasted from the web, or
// agent-generated/edited) gets a sequential, per-conversation tag --
// "image1", "image2", ... in the order it appears -- shown as a clickable
// badge on its thumbnail (see renderMessage above) and typeable in the
// composer. This is purely a human-friendly stand-in for the image's real
// ChatImage id (which tools like edit_image actually operate on, and which
// the model already sees via the "[Image id=N: ...]" placeholder text --
// see toApiMessage): typing/clicking "@image2" instead of hunting for "id
// 37" in the transcript is the whole point, and resolveMentions() below
// swaps it back to "image id=37" only in the outgoing API payload, so the
// model still gets an unambiguous id despite never seeing the tag itself.
function imageTagEntries() {
  const entries = [];
  let n = 0;
  for (const m of currentConvo.messages) {
    // Pending/failed renders (#10) have no bytes to resolve yet -- don't
    // make them @-mentionable/attachable until they actually resolve.
    if (m.kind !== "image" || m.status === "pending" || m.status === "failed") continue;
    n += 1;
    entries.push({ tag: `image${n}`, id: m.image_id, url: m.image_url });
  }
  return entries;
}

function imageTagForId(imageId) {
  const entry = imageTagEntries().find((e) => e.id === imageId);
  return entry ? entry.tag : null;
}

function imageTagToIdMap() {
  return new Map(imageTagEntries().map((e) => [e.tag, e.id]));
}

const MENTION_TOKEN_RE = /@image(\d+)\b/gi;

// Swaps "@image2" for "image id=37" (leaving anything that doesn't match a
// real tag alone) -- called from toApiMessage when building the payload,
// never touches the stored/displayed message text itself.
function resolveMentions(text, tagToId) {
  return text.replace(MENTION_TOKEN_RE, (whole, n) => {
    const id = tagToId.get(`image${n}`);
    return id != null ? `image id=${id}` : whole;
  });
}

function imageUrlForId(imageId) {
  const entry = imageTagEntries().find((e) => e.id === imageId);
  return entry ? entry.url : null;
}

// Images explicitly @-mentioned anywhere in the conversation's stored text
// -- the sole "attach this for edit_image to work on" signal (per the #11
// UX decision: no separate attach control). Scoping attached_images to
// just these, rather than every image ever in the conversation, keeps the
// outgoing request body from growing without bound as a conversation
// accumulates images that are never referred back to.
function mentionedImageIds(tagToId) {
  const ids = new Set();
  for (const m of currentConvo.messages) {
    if (typeof m.content !== "string") continue;
    for (const match of m.content.matchAll(MENTION_TOKEN_RE)) {
      const id = tagToId.get(`image${match[1]}`);
      if (id != null) ids.add(id);
    }
  }
  return ids;
}

let mentionState = null; // { start, end, entries, selectedIndex } while the dropdown is open; else null

// Finds the "@word" token (if any) the caret currently sits inside, so
// onComposerInput knows whether to open the mention dropdown and what to
// filter it by.
function detectMentionQuery(input) {
  const value = input.value;
  const caret = input.selectionStart;
  if (caret == null) return null;
  let start = caret;
  while (start > 0 && !/\s/.test(value[start - 1])) start--;
  if (value[start] !== "@") return null;
  return { start, end: caret, query: value.slice(start + 1, caret) };
}

// Grows the composer textarea to fit its content (CSS max-height + overflow
// caps it beyond that). Must be called manually after any programmatic
// `.value =` assignment -- those don't fire an "input" event.
function autoResizeComposerInput() {
  const input = el("message-input");
  input.style.height = "auto";
  input.style.height = `${input.scrollHeight}px`;
}

function onComposerInput() {
  const input = el("message-input");
  autoResizeComposerInput();
  const mention = detectMentionQuery(input);
  if (!mention) { hideMentionDropdown(); return; }
  const query = mention.query.toLowerCase();
  const entries = imageTagEntries().filter((e) => e.tag.toLowerCase().startsWith(query));
  if (!entries.length) { hideMentionDropdown(); return; }
  showMentionDropdown(entries, mention);
}

function showMentionDropdown(entries, mention) {
  const dropdown = el("mention-dropdown");
  dropdown.innerHTML = "";
  entries.forEach((entry, i) => {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "mention-item" + (i === 0 ? " selected" : "");
    const img = document.createElement("img");
    img.src = LOADING_THUMB_SRC;
    img.alt = "";
    resolveImageBytes(entry.id, entry.url).then((resolved) => {
      if (resolved) img.src = trackedMentionBlobUrl(resolved.bytes, resolved.contentType);
    });
    const label = document.createElement("span");
    label.textContent = `@${entry.tag}`;
    item.append(img, label);
    // mousedown (not click) + preventDefault so the input never blurs --
    // a click would fire after blur has already closed the dropdown.
    item.addEventListener("mousedown", (e) => { e.preventDefault(); selectMention(i); });
    dropdown.appendChild(item);
  });
  dropdown.hidden = false;
  mentionState = { start: mention.start, end: mention.end, entries, selectedIndex: 0 };
}

function hideMentionDropdown() {
  mentionState = null;
  el("mention-dropdown").hidden = true;
  el("mention-dropdown").innerHTML = "";
  revokeMentionBlobUrls();
}

function moveMentionSelection(delta) {
  const items = el("mention-dropdown").querySelectorAll(".mention-item");
  if (!mentionState || !items.length) return;
  const n = items.length;
  mentionState.selectedIndex = (mentionState.selectedIndex + delta + n) % n;
  items.forEach((it, i) => it.classList.toggle("selected", i === mentionState.selectedIndex));
}

function selectMention(index) {
  if (!mentionState) return;
  const entry = mentionState.entries[index];
  if (!entry) return;
  const input = el("message-input");
  const before = input.value.slice(0, mentionState.start);
  const after = input.value.slice(mentionState.end);
  const insertion = `@${entry.tag} `;
  input.value = before + insertion + after;
  const caret = before.length + insertion.length;
  hideMentionDropdown();
  input.focus();
  input.setSelectionRange(caret, caret);
  autoResizeComposerInput();
}

function onComposerKeydown(e) {
  if (mentionState) {
    if (e.key === "ArrowDown") { e.preventDefault(); moveMentionSelection(1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); moveMentionSelection(-1); }
    else if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); selectMention(mentionState.selectedIndex); }
    else if (e.key === "Escape") { hideMentionDropdown(); }
    return;
  }
  // Textareas don't submit their form on Enter the way a text <input> did --
  // Enter alone now sends, Shift+Enter inserts a newline like every other
  // chat composer.
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    el("send-form").requestSubmit();
  }
}

// Inserts "@imageN" at the current cursor position (or over the current
// selection) -- used by the thumbnail badge's click handler, as opposed to
// selectMention() above which replaces an in-progress "@..." token.
function insertMentionAtCursor(tag) {
  const input = el("message-input");
  const start = input.selectionStart ?? input.value.length;
  const end = input.selectionEnd ?? input.value.length;
  const before = input.value.slice(0, start);
  const needsSpaceBefore = before.length > 0 && !/\s$/.test(before);
  const insertion = `${needsSpaceBefore ? " " : ""}@${tag} `;
  input.value = before + insertion + input.value.slice(end);
  const caret = before.length + insertion.length;
  input.focus();
  input.setSelectionRange(caret, caret);
  autoResizeComposerInput();
}

// AI replies get a copy/retry row underneath, always visible (unlike the
// tap-to-reveal treatment on user bubbles -- the full-width plain-text
// layout has room to spare, and these are the actions people reach for
// most on a reply). Hidden while the reply is still the "thinking" dots
// or mid-stream-with-no-text-yet via the CSS sibling rule on .thinking.
function renderAssistantMessage(m) {
  const wrap = document.createElement("div");
  wrap.className = "msg-wrap-assistant";

  // Which model actually answered, and how long the turn took -- filled in
  // once the "model"/"done" SSE events arrive (see handleEvent);
  // empty/collapsed via CSS :empty until then, and already populated on
  // reload for a persisted message.
  const modelLabel = document.createElement("div");
  modelLabel.className = "msg-model-label";
  modelLabel.textContent = modelLabelText(m);
  wrap.appendChild(modelLabel);

  const div = document.createElement("div");
  div.className = "msg msg-assistant msg-markdown";
  if (m.isError) div.classList.add("msg-error");
  div.innerHTML = renderMarkdown(m.content);
  wrap.appendChild(div);

  const actions = document.createElement("div");
  actions.className = "msg-actions msg-actions-assistant";

  const copyBtn = document.createElement("button");
  copyBtn.type = "button";
  copyBtn.className = "msg-action-btn";
  copyBtn.title = "Copy";
  copyBtn.innerHTML = `<span class="icon-copy">${COPY_SVG}</span><span class="icon-check">${CHECK_SVG}</span>`;
  copyBtn.addEventListener("click", () => copyMessageText(m.content, copyBtn));
  actions.appendChild(copyBtn);

  const retryBtn = document.createElement("button");
  retryBtn.type = "button";
  retryBtn.className = "msg-action-btn";
  retryBtn.title = "Retry";
  retryBtn.innerHTML = RETRY_SVG;
  retryBtn.addEventListener("click", () => retryMessage(m));
  actions.appendChild(retryBtn);

  wrap.appendChild(actions);
  return wrap;
}

// Plain user text messages get a tap-to-reveal row underneath (timestamp,
// copy, edit) instead of always-visible chrome -- keeps the bubble itself
// clean, matching how most chat apps handle it.
function renderUserMessage(m) {
  const wrap = document.createElement("div");
  wrap.className = "msg-wrap";

  const bubble = document.createElement("div");
  bubble.className = "msg msg-user msg-markdown";
  bubble.innerHTML = renderMarkdown(m.content);
  bubble.addEventListener("click", () => wrap.classList.toggle("expanded"));
  wrap.appendChild(bubble);

  const actions = document.createElement("div");
  actions.className = "msg-actions";
  const ts = document.createElement("span");
  ts.className = "msg-timestamp";
  ts.textContent = formatTimestamp(m.timestamp);
  actions.appendChild(ts);

  const copyBtn = document.createElement("button");
  copyBtn.type = "button";
  copyBtn.className = "msg-action-btn";
  copyBtn.title = "Copy";
  // Both icons are always in the DOM; only a CSS class toggles which one
  // shows (see copyMessageText). Swapping .innerHTML at runtime instead was
  // the earlier approach and was unreliable in the field -- this sidesteps
  // that class of bug entirely rather than chasing the exact repaint cause.
  copyBtn.innerHTML = `<span class="icon-copy">${COPY_SVG}</span><span class="icon-check">${CHECK_SVG}</span>`;
  copyBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    copyMessageText(m.content, copyBtn);
  });
  actions.appendChild(copyBtn);

  const editBtn = document.createElement("button");
  editBtn.type = "button";
  editBtn.className = "msg-action-btn";
  editBtn.title = "Edit";
  editBtn.innerHTML = EDIT_SVG;
  editBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    startEditMessage(m, wrap);
  });
  actions.appendChild(editBtn);

  wrap.appendChild(actions);
  return wrap;
}

async function copyMessageText(text, btn) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    return; // clipboard API needs a secure context; fail silently if unavailable
  }
  btn.classList.add("copied");
  clearTimeout(btn._copyRevertTimer);
  btn._copyRevertTimer = setTimeout(() => btn.classList.remove("copied"), 1200);
}

// Editing a past message truncates the conversation from that point on
// (like ChatGPT's edit) and resends -- reuses the normal send flow by
// filling the composer and submitting it, rather than duplicating the
// agent-call logic here.
function startEditMessage(m, wrap) {
  wrap.classList.add("editing"); // breaks out of the bubble's 70%-width constraint (see .msg-wrap.editing)
  const bubble = wrap.querySelector(".msg");
  const textarea = document.createElement("textarea");
  textarea.className = "msg-edit-textarea";
  textarea.value = m.content;
  bubble.replaceWith(textarea);
  textarea.focus();
  textarea.setSelectionRange(textarea.value.length, textarea.value.length);
  wrap.querySelector(".msg-actions").style.display = "none";

  const controls = document.createElement("div");
  controls.className = "msg-edit-controls";
  const cancelBtn = document.createElement("button");
  cancelBtn.type = "button";
  cancelBtn.textContent = "Cancel";
  cancelBtn.addEventListener("click", renderMessages); // discards the in-progress edit, re-renders from source of truth
  const sendBtn = document.createElement("button");
  sendBtn.type = "button";
  sendBtn.className = "btn-primary";
  sendBtn.textContent = "Send";
  sendBtn.addEventListener("click", () => {
    const newText = textarea.value.trim();
    if (newText) saveEditMessage(m, newText);
  });
  controls.appendChild(cancelBtn);
  controls.appendChild(sendBtn);
  wrap.appendChild(controls);
}

function saveEditMessage(m, newText) {
  const idx = currentConvo.messages.indexOf(m);
  if (idx === -1) return;
  currentConvo.messages.splice(idx); // drop this message and everything after it
  renderMessages();
  el("message-input").value = newText;
  autoResizeComposerInput();
  el("send-form").requestSubmit();
}

function appendMessage(m) {
  currentConvo.messages.push(m);
  const node = renderMessage(m);
  el("messages").appendChild(node);
  maybeScrollToBottom();
  return { message: m, node };
}

// Like appendMessage, but inserts before an existing DOM node instead of at
// the end -- used for tool-result messages (generated images/notes) during
// a turn, so they land above the assistant's final-answer bubble (which is
// already on screen as a "thinking" placeholder) both in the DOM and in
// currentConvo.messages, matching the true chronological order: the tool
// runs and its result is known BEFORE the model writes the text that refers
// to it. See runAgentTurn/handleEvent.
function insertMessage(m, beforeNode) {
  currentConvo.messages.push(m);
  const node = renderMessage(m);
  el("messages").insertBefore(node, beforeNode);
  maybeScrollToBottom();
  return { message: m, node };
}

// ---------- Image attach ----------

async function onAttachChange(e) {
  const files = Array.from(e.target.files);
  el("attach-input").value = ""; // allow re-picking the same file(s) next time
  for (const file of files) {
    await uploadAttachment(file);
  }
}

// Reads the file directly and stores it in the local "images" store --
// no server round-trip at all (#11 stage 2). Shows an instant local blob:
// preview, which stays as the thumbnail's permanent src since there's
// nothing to swap it for anymore.
async function uploadAttachment(file) {
  const localPreviewUrl = URL.createObjectURL(file);
  const holder = { id: null, source: "upload", previewUrl: localPreviewUrl }; // filled in below; the remove button closes over this
  const thumb = addAttachThumb(localPreviewUrl, holder);
  const contentType = file.type || "image/png";
  const id = crypto.randomUUID();
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    await Crypto.storeImage(imageKey, id, bytes, contentType);
  } catch {
    URL.revokeObjectURL(localPreviewUrl);
    thumb.remove();
    el("attach-status").textContent = `${file.name}: couldn't store that image.`;
    return;
  }
  holder.id = id;
  pendingImageAttachments.push(holder);
  updateAttachStatus();
}

// A blank 1x1 placeholder shown in the thumb strip while a pasted image URL
// is being fetched server-side -- unlike uploadAttachment() there's no local
// file to make a blob: preview from until the round-trip finishes.
const LOADING_THUMB_SRC = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBTAA7";

// Same shape as uploadAttachment, but for an image pasted as a URL (or
// found in pasted HTML) rather than as clipboard file bytes -- see
// onComposerPaste. The fetch still happens server-side
// (chat-images/fetch-url, SSRF-guarded) since a client-side fetch() of an
// arbitrary third-party image host would usually be blocked by CORS before
// the bytes could be read into a blob -- but the server no longer stores
// what it fetches (#11 stage 2), it just hands the bytes back as base64
// for the client to store locally, same as a direct upload.
async function uploadAttachmentFromUrl(url) {
  const holder = { id: null, source: "url", previewUrl: null };
  const thumb = addAttachThumb(LOADING_THUMB_SRC, holder);
  thumb.classList.add("attach-thumb-loading");
  el("attach-status").textContent = "Fetching image...";
  let resp;
  try {
    resp = await fetch("/api/chat-images/fetch-url", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
    });
  } catch {
    thumb.remove();
    el("attach-status").textContent = "Couldn't fetch that image.";
    return;
  }
  if (!resp.ok) {
    thumb.remove();
    const detail = await resp.json().catch(() => null);
    el("attach-status").textContent = (detail && detail.detail) || "Couldn't fetch that image.";
    return;
  }
  const result = await resp.json();
  const bytes = new Uint8Array(Crypto.b64ToBuf(result.data_b64));
  const contentType = result.content_type || "image/png";
  const id = crypto.randomUUID();
  try {
    await Crypto.storeImage(imageKey, id, bytes, contentType);
  } catch {
    thumb.remove();
    el("attach-status").textContent = "Couldn't store that image.";
    return;
  }
  const previewUrl = URL.createObjectURL(new Blob([bytes], { type: contentType }));
  holder.id = id;
  holder.previewUrl = previewUrl;
  thumb.classList.remove("attach-thumb-loading");
  thumb.querySelector("img").src = previewUrl;
  pendingImageAttachments.push(holder);
  updateAttachStatus();
}

// Recognizes a paste as an image in three ways, in order: (1) actual image
// bytes on the clipboard (e.g. Chrome/Firefox's "Copy image" on a web page
// puts real image data there, same as a screenshot paste); (2) plain text
// that's nothing but an image URL (e.g. pasting an image address); (3) an
// <img src> pulled out of pasted HTML (some sites/apps put a rich HTML
// fragment on the clipboard instead of raw image bytes when you copy an
// image). Falls through to the browser's normal paste for anything else.
const IMAGE_URL_RE = /^https?:\/\/\S+\.(?:png|jpe?g|gif|webp|avif|bmp|svg)(?:\?\S*)?$/i;
const HTML_IMG_SRC_RE = /<img[^>]+src=["']([^"']+)["']/i;

async function onComposerPaste(e) {
  const cd = e.clipboardData;
  if (!cd) return;

  const imageFiles = Array.from(cd.items || [])
    .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
    .map((item) => item.getAsFile())
    .filter(Boolean);
  if (imageFiles.length) {
    e.preventDefault();
    for (const file of imageFiles) await uploadAttachment(file);
    return;
  }

  const text = (cd.getData("text/plain") || "").trim();
  if (IMAGE_URL_RE.test(text)) {
    e.preventDefault();
    await uploadAttachmentFromUrl(text);
    return;
  }

  const html = cd.getData("text/html");
  const match = html && html.match(HTML_IMG_SRC_RE);
  if (match && /^https?:\/\//i.test(match[1])) {
    e.preventDefault();
    await uploadAttachmentFromUrl(match[1]);
  }
}

function addAttachThumb(previewUrl, holder) {
  const thumb = document.createElement("div");
  thumb.className = "attach-thumb";
  const img = document.createElement("img");
  img.src = previewUrl;
  img.alt = "Attached image preview";
  const removeBtn = document.createElement("button");
  removeBtn.type = "button";
  removeBtn.className = "attach-remove-btn";
  removeBtn.title = "Remove attachment";
  removeBtn.textContent = "×";
  removeBtn.addEventListener("click", () => {
    pendingImageAttachments = pendingImageAttachments.filter((a) => a !== holder);
    thumb.remove();
    if (holder.previewUrl) URL.revokeObjectURL(holder.previewUrl);
    if (holder.id) Crypto.deleteImage(holder.id);
    updateAttachStatus();
  });
  thumb.append(img, removeBtn);
  el("attach-preview").hidden = false;
  el("attach-preview").appendChild(thumb);
  return thumb;
}

function updateAttachStatus() {
  if (!pendingImageAttachments.length) {
    el("attach-status").textContent = "";
    return;
  }
  const turnModel = (currentConvo && currentConvo.model) || defaultModel || "";
  const note = modelSupportsVision(turnModel)
    ? ""
    : " (current model doesn't look vision-capable -- sent as a reference only, not the image itself)";
  el("attach-status").textContent = `Will send with your next message.${note}`;
}

function clearAttachPreview() {
  el("attach-preview").hidden = true;
  el("attach-preview").innerHTML = "";
}

// Data: URLs for images already sent to the LLM this session, keyed by
// image_id -- avoids re-reading/re-encoding the same image from the
// "images" store on every turn (the whole history is resent each turn).
// Deliberately NOT stored on the message object / currentConvo.messages,
// since that gets persisted to IndexedDB via persistCurrentConvo.
const imageDataUrlCache = new Map();

// Returns null if the image can't be resolved at all (neither locally nor,
// for a pre-migration legacy reference, via legacyUrl) -- callers fall back
// to the text-only placeholder in that case.
async function imageToDataUrl(imageId, legacyUrl) {
  if (imageDataUrlCache.has(imageId)) return imageDataUrlCache.get(imageId);
  const resolved = await resolveImageBytes(imageId, legacyUrl);
  if (!resolved) return null;
  const dataUrl = `data:${resolved.contentType};base64,${Crypto.bufToB64(resolved.bytes)}`;
  imageDataUrlCache.set(imageId, dataUrl);
  return dataUrl;
}

// Converts a stored message into the {role, content} shape sent to the LLM.
// Notes are pure UI artifacts with no binary payload, so they still go as a
// text placeholder. Images go as a text placeholder too (so the model can
// still recall the id across turns, e.g. to call edit_image on it later),
// plus -- only when visionCapable, per the calling model's cached
// modelSupportsVision() result -- the actual image bytes as a data: URL in
// OpenAI-style multipart content, so vision-capable models can see them.
async function toApiMessage(m, visionCapable, tagToId) {
  if (m.kind === "image") {
    const label = m.source === "upload" ? "the user uploaded an image"
      : m.source === "url" ? "the user pasted in an image from the web"
      : `an image was ${m.source === "edited" ? "edited" : "generated"} (prompt: "${m.prompt}")`;
    const placeholder = `[Image id=${m.image_id}: ${label}]`;
    if (!visionCapable) {
      return { role: m.role, content: placeholder };
    }
    const dataUrl = await imageToDataUrl(m.image_id, m.image_url);
    if (!dataUrl) {
      return { role: m.role, content: placeholder };
    }
    return {
      role: m.role,
      content: [
        { type: "text", text: placeholder },
        { type: "image_url", image_url: { url: dataUrl } },
      ],
    };
  }
  if (m.kind === "note") {
    return { role: "assistant", content: `[Note "${m.title}"]\n${m.content}` };
  }
  const content = typeof m.content === "string" ? resolveMentions(m.content, tagToId) : m.content;
  return { role: m.role, content };
}

// ---------- Sending ----------

async function onSend(e) {
  e.preventDefault();
  const input = el("message-input");
  const text = input.value.trim();
  const attachments = pendingImageAttachments;
  if (!text && !attachments.length) return;
  input.value = "";
  autoResizeComposerInput();
  hideMentionDropdown();
  pendingImageAttachments = [];
  clearAttachPreview();
  el("attach-status").textContent = "";
  el("attach-input").value = "";

  for (const attachment of attachments) {
    appendMessage({ role: "user", kind: "image", image_id: attachment.id, source: attachment.source || "upload" });
    // The composer preview's blob: URL is now obsolete -- the just-appended
    // message renders its own, freshly resolved from the "images" store.
    if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
  }
  if (text) {
    appendMessage({ role: "user", content: text, timestamp: Date.now() });
  }
  forceScrollToBottom();
  if (currentConvo.messages.filter((m) => m.role === "user").length === 1) {
    deriveTitle();
    updateChatTitle();
  }
  await persistCurrentConvo();
  await refreshConversationList();

  await runAgentTurn();
}

// Appends an assistant bubble and streams a reply into it from whatever's
// currently in currentConvo.messages -- shared by onSend and retryMessage,
// which just differ in what's already in the conversation before this runs.
//
// The assistant message's DOM placeholder is shown immediately (for the
// "thinking" dots), but the message object itself is only pushed into
// currentConvo.messages once the turn actually produces content, at the very
// end of this function -- any tool-result messages (generated images/notes)
// created in between via handleEvent's insertMessage() calls land in the
// array first, ahead of it, which is both the true chronological order and
// what keeps retryMessage's turnId-based cleanup correct (see below).
async function runAgentTurn() {
  const turnId = `t${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const assistantMsg = { role: "assistant", content: "", turnId };
  const assistantWrap = renderAssistantMessage(assistantMsg);
  const assistantNode = assistantWrap.querySelector(".msg");
  el("messages").appendChild(assistantWrap);
  maybeScrollToBottom();
  setThinking(assistantNode, true);

  // Show the model we're about to call right away, rather than waiting on
  // the server's "model" SSE event -- that only arrives after the LLM
  // roundtrip completes, well after the thinking dots appear. Overwritten
  // below if the endpoint echoes back a different resolved model id.
  const expectedModel = (currentConvo && currentConvo.model) || defaultModel || "";
  if (expectedModel) {
    assistantMsg.model = expectedModel;
    const label = assistantWrap.querySelector(".msg-model-label");
    if (label) label.textContent = modelLabelText(assistantMsg);
  }

  // Timed client-side (see formatElapsed) -- toolStartTime is set/consumed
  // per tool_call/tool_result pair, startTime spans the whole turn for the
  // final reply's elapsed time. Passed into handleEvent below.
  const turnTiming = { startTime: performance.now(), toolStartTime: null };

  const statusEl = document.createElement("div");
  statusEl.className = "tool-status";
  el("messages").appendChild(statusEl);

  const turnModel = (currentConvo && currentConvo.model) || defaultModel || "";
  const visionCapable = modelSupportsVision(turnModel);
  const tagToId = imageTagToIdMap();
  const apiMessages = await Promise.all(
    currentConvo.messages
      .filter((m) => m.role === "user" || m.role === "assistant")
      .map((m) => toApiMessage(m, visionCapable, tagToId))
  );

  const attachedImages = [];
  for (const id of mentionedImageIds(tagToId)) {
    const resolved = await resolveImageBytes(id, imageUrlForId(id));
    if (resolved) {
      attachedImages.push({ id, data_b64: Crypto.bufToB64(resolved.bytes), content_type: resolved.contentType });
    }
  }

  activeAbortController = new AbortController();
  setSendingState(true);

  try {
    const resp = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: apiMessages,
        active_document_ids: currentConvo.activeDocumentIds,
        model: currentConvo.model || "",
        profile_id: currentConvo.profileId || null,
        attached_images: attachedImages,
      }),
      signal: activeAbortController.signal,
    });
    if (!resp.ok || !resp.body) throw new Error(`HTTP ${resp.status}`);

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split("\n\n");
      buffer = parts.pop();
      for (const part of parts) {
        const line = part.trim();
        if (!line.startsWith("data:")) continue;
        const event = JSON.parse(line.slice(5).trim());
        await handleEvent(event, assistantMsg, assistantNode, statusEl, turnTiming);
      }
    }
  } catch (err) {
    if (err.name === "AbortError") {
      statusEl.remove();
    } else {
      renderError(err.message, assistantMsg, assistantNode, statusEl);
    }
  } finally {
    activeAbortController = null;
    setSendingState(false);
  }

  // If the turn ended (aborted before any tokens arrived) without any
  // actual reply text, don't leave a dangling empty bubble behind. Errors no
  // longer hit this path -- renderError() above always leaves content behind
  // so the bubble (and its model label / copy / retry row) stays put.
  // Otherwise, this is the one place the assistant message actually joins
  // currentConvo.messages -- see the comment on runAgentTurn above.
  if (!assistantMsg.content) {
    assistantWrap.remove();
  } else {
    currentConvo.messages.push(assistantMsg);
  }

  await persistCurrentConvo();
}

// Tracks the in-flight /api/chat request so the composer's send button can
// double as a stop button while a reply is streaming.
let activeAbortController = null;

function setSendingState(active) {
  const btn = el("send-btn");
  btn.classList.toggle("stop-mode", active);
  btn.type = active ? "button" : "submit";
  btn.setAttribute("aria-label", active ? "Stop" : "Send");
  el("send-icon-send").style.display = active ? "none" : "";
  el("send-icon-stop").style.display = active ? "" : "none";
  if (active) requestWakeLock(); else releaseWakeLock();
}

// Keeps the screen from auto-locking while a turn (LLM roundtrip or a slow
// tool like generate_image/edit_image, which can take minutes) is in
// flight. As of #10, an in-flight image render specifically survives the
// connection dying (reconcileRenderJobs() picks it up on return) -- but
// the rest of the turn (any text reply, non-image tool results) still
// doesn't, so losing the tab mid-turn still loses those. Doesn't help with
// switching away from the tab/app entirely -- only screen auto-lock -- and
// silently does nothing on browsers without Wake Lock support (notably
// desktop Firefox) rather than failing the turn over it.
let wakeLock = null;

async function requestWakeLock() {
  if (!("wakeLock" in navigator)) return;
  try {
    wakeLock = await navigator.wakeLock.request("screen");
  } catch {
    wakeLock = null; // e.g. denied, or the page isn't visible right now
  }
}

function releaseWakeLock() {
  if (!wakeLock) return;
  wakeLock.release().catch(() => {});
  wakeLock = null;
}

// The spec releases the wake lock automatically when the tab is hidden
// (locking the screen counts) -- re-acquire on return if a turn is still
// running, otherwise the rest of that same turn is unprotected. Also the
// other trigger (besides boot()) for reconcileRenderJobs() (#10) -- covers
// coming back to a tab that was backgrounded during a render, without
// needing a full reload.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    if (activeAbortController && !wakeLock) requestWakeLock();
    reconcileRenderJobs();
  }
});

// Drops this reply (and its tool-generated images/notes from the same turn,
// which now sit BEFORE it in currentConvo.messages -- see runAgentTurn --
// identified by a shared turnId, plus anything after it) and re-runs the
// turn from the same conversation state that produced it. Older persisted
// messages predating turnId just fall back to dropping from this index on.
async function retryMessage(m) {
  const idx = currentConvo.messages.indexOf(m);
  if (idx === -1) return;
  let startIdx = idx;
  if (m.turnId) {
    while (startIdx > 0 && currentConvo.messages[startIdx - 1].turnId === m.turnId) startIdx--;
  }
  currentConvo.messages.splice(startIdx);
  renderMessages();
  await runAgentTurn();
}

// Shows/hides a bouncing-dots "thinking" indicator inside an (initially
// empty) assistant message bubble while waiting for the first token.
function setThinking(node, on) {
  node.classList.toggle("thinking", on);
  if (on) {
    node.innerHTML = '<span class="dot"></span><span class="dot"></span><span class="dot"></span>';
  } else {
    node.innerHTML = "";
  }
}

async function handleEvent(event, assistantMsg, assistantNode, statusEl, turnTiming) {
  if (event.type === "heartbeat") {
    // Sent periodically while the server is waiting on a slow non-
    // streaming LLM call or tool execution (vision calls especially) so
    // the connection doesn't go long enough without bytes to trip our own
    // network stack's idle/request timeout -- see agent.py's
    // _with_heartbeat. Nothing to do with it client-side; its only job is
    // to have arrived at all.
  } else if (event.type === "token") {
    if (assistantNode.classList.contains("thinking")) setThinking(assistantNode, false);
    assistantMsg.content += event.content;
    assistantNode.innerHTML = renderMarkdown(assistantMsg.content);
    maybeScrollToBottom();
  } else if (event.type === "model") {
    assistantMsg.model = event.name;
    const label = assistantNode.parentElement.querySelector(".msg-model-label");
    if (label) label.textContent = modelLabelText(assistantMsg);
  } else if (event.type === "tool_call") {
    turnTiming.toolStartTime = performance.now();
    turnTiming.lastToolCallArgs = event.args;
    statusEl.textContent = `Using ${event.name}...`;
  } else if (event.type === "render_job") {
    // Announced before the (possibly multi-minute) render starts, not
    // buried in a tool_result that would only arrive after it finishes --
    // see render_jobs.py / #10. Insert the placeholder AND persist right
    // away, not at turn end like everything else here: this is the actual
    // fix for the bug (today nothing hits IndexedDB until the whole turn
    // finishes, so a mid-render disconnect loses it with nothing to
    // recover from on return).
    const assistantWrap = assistantNode.parentElement;
    const args = turnTiming.lastToolCallArgs || {};
    insertMessage({
      role: "assistant", kind: "image", turnId: assistantMsg.turnId, jobId: event.job_id,
      status: "pending", prompt: args.prompt || "", source: event.name === "edit_image" ? "edited" : "generated",
    }, assistantWrap);
    await persistCurrentConvo();
  } else if (event.type === "tool_result") {
    const assistantWrap = assistantNode.parentElement;
    const elapsedMs = turnTiming.toolStartTime != null ? performance.now() - turnTiming.toolStartTime : null;
    turnTiming.toolStartTime = null;
    if (event.name === "generate_image" || event.name === "edit_image") {
      const jobId = event.result.job_id;
      if (event.result.image_b64) {
        // Store the bytes locally before resolving the placeholder --
        // renderMessage's resolution for this message id then finds them
        // immediately, no round trip to anywhere.
        const bytes = new Uint8Array(Crypto.b64ToBuf(event.result.image_b64));
        await Crypto.storeImage(imageKey, event.result.image_id, bytes, event.result.content_type || "image/png");
        const resolved = jobId && updateImageMessageByJobId(jobId, (msg) => {
          delete msg.status;
          delete msg.error;
          msg.image_id = event.result.image_id;
          msg.elapsedMs = elapsedMs;
          msg.prompt = event.result.prompt;
        });
        if (!resolved) {
          // No matching pending placeholder -- shouldn't normally happen,
          // since the render_job event always precedes this one for these
          // tools, but fall back to inserting fresh rather than dropping
          // the result.
          insertMessage({
            role: "assistant", kind: "image", turnId: assistantMsg.turnId, elapsedMs, jobId,
            image_id: event.result.image_id, prompt: event.result.prompt,
            source: event.name === "edit_image" ? "edited" : "generated",
          }, assistantWrap);
        }
        // The client has the bytes now via the normal path -- the job row
        // is redundant, clean it up rather than leaving it to the TTL sweep.
        if (jobId) fetch(`/api/render-jobs/${jobId}`, { method: "DELETE" }).catch(() => {});
      } else if (event.result.error) {
        const resolved = jobId && updateImageMessageByJobId(jobId, (msg) => { msg.status = "failed"; msg.error = event.result.error; });
        if (!resolved) statusEl.textContent = `${event.name} error: ${event.result.error}`;
        if (jobId) fetch(`/api/render-jobs/${jobId}`, { method: "DELETE" }).catch(() => {});
      }
      await persistCurrentConvo();
    } else if (event.name === "create_note") {
      insertMessage({ role: "assistant", kind: "note", turnId: assistantMsg.turnId, title: event.result.title, content: event.result.content_markdown }, assistantWrap);
    } else if (event.result && event.result.error) {
      statusEl.textContent = `${event.name} error: ${event.result.error}`;
    }
    statusEl.textContent = "";
  } else if (event.type === "error") {
    renderError(event.message, assistantMsg, assistantNode, statusEl);
  } else if (event.type === "done") {
    assistantMsg.elapsedMs = performance.now() - turnTiming.startTime;
    const label = assistantNode.parentElement.querySelector(".msg-model-label");
    if (label) label.textContent = modelLabelText(assistantMsg);
    statusEl.remove();
  }
}

// Renders a failed turn as the reply itself -- with the usual model label
// and copy/retry row -- rather than a status line that would vanish along
// with the (otherwise-removed) empty bubble; retry needs a bubble to hang
// off of. If tokens had already streamed in before the failure, the error
// is appended rather than replacing what the model had already said.
function renderError(message, assistantMsg, assistantNode, statusEl) {
  setThinking(assistantNode, false);
  if (assistantMsg.content) {
    assistantMsg.content += `\n\n⚠️ ${message}`;
    assistantNode.innerHTML = renderMarkdown(assistantMsg.content);
  } else {
    assistantMsg.content = message;
    assistantMsg.isError = true;
    assistantNode.textContent = message;
    assistantNode.classList.add("msg-error");
  }
  statusEl.remove();
}

init();
