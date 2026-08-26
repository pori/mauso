// Read-only conversation-history sidebar for the Files/Settings pages --
// the Chat page (app.js) owns the full read/write version with rename/
// clone/delete/model-picker etc. This just needs enough to show recent
// conversations and get back to one (or start a new one), using whatever
// key is already cached in sessionStorage from unlocking on the Chat page
// (see crypto.js's cacheKeyForSession/restoreKeyFromSession).
import * as Crypto from "./crypto.js";

const el = (id) => document.getElementById(id);

async function render() {
  const listEl = el("convo-list");
  if (!listEl) return;
  const key = await Crypto.restoreKeyFromSession();
  if (!key) {
    listEl.innerHTML = '<p class="hint">Unlock on the Chat page to see your history.</p>';
    return;
  }
  const records = await Crypto.listConversationRecords();
  listEl.innerHTML = "";
  if (records.length === 0) {
    listEl.innerHTML = '<p class="hint">No conversations yet.</p>';
    return;
  }
  for (const r of records) {
    const data = await Crypto.loadConversation(key, r.id).catch(() => null);
    const row = document.createElement("div");
    row.className = "convo-item-row";
    const item = document.createElement("a");
    item.className = "convo-item";
    item.href = `/?c=${encodeURIComponent(r.id)}`;
    item.textContent = data ? (data.title || "Untitled") : "(undecryptable)";
    row.appendChild(item);
    listEl.appendChild(row);
  }
}

el("new-convo-btn")?.addEventListener("click", () => { window.location.href = "/?new=1"; });
el("lock-btn")?.addEventListener("click", () => { Crypto.clearSessionKey(); window.location.href = "/"; });

render();
