// Client-side-only search across conversation history. Everything here runs
// against conversation objects already decrypted in the browser (the same
// Crypto.loadConversation() call app.js's refreshConversationList() already
// makes to show titles) -- this module never touches the network,
// IndexedDB, or sessionStorage itself, so the search query and its results
// never leave the tab. Plain case-insensitive substring match, mirroring
// the backend's search_notes convention (tools/notes.py), kept as a
// dependency-free module so it's testable with `node --test` (see
// tests/js/search.test.mjs) without a DOM.

const SNIPPET_CONTEXT_CHARS = 40;

// Message content is usually a plain string, but a vision-capable turn's
// content can be the multipart array shape from toApiMessage() in app.js
// ([{type: "text", text}, {type: "image_url", ...}]) -- only the text parts
// are searchable. Note/image tool-result messages (see renderMessage in
// app.js) don't use `content` for their user-visible text at all, so those
// are folded in separately below.
function searchableText(m) {
  const parts = [];
  if (typeof m.content === "string") {
    parts.push(m.content);
  } else if (Array.isArray(m.content)) {
    parts.push(...m.content.filter((p) => p && p.type === "text").map((p) => p.text || ""));
  }
  if (m.kind === "note") {
    if (m.title) parts.push(m.title);
    if (m.content && typeof m.content === "string") parts.push(m.content);
  }
  if (m.kind === "image" && m.prompt) {
    parts.push(m.prompt);
  }
  return parts.join(" ");
}

// Finds the first case-insensitive occurrence of `query` in `text` and
// returns a short excerpt around it (with "…" ellipses on whichever side got
// cut off), or null if there's no match.
export function extractSnippet(text, query) {
  if (!text || !query) return null;
  const idx = text.toLowerCase().indexOf(query.toLowerCase());
  if (idx === -1) return null;
  const start = Math.max(0, idx - SNIPPET_CONTEXT_CHARS);
  const end = Math.min(text.length, idx + query.length + SNIPPET_CONTEXT_CHARS);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < text.length ? "…" : "";
  return `${prefix}${text.slice(start, end).trim()}${suffix}`;
}

// conversations: [{id, title, messages}], already decrypted plaintext (as
// returned by Crypto.loadConversation), in whatever order the caller passes
// -- this doesn't re-sort them, so callers should pass them pre-sorted by
// recency the way Crypto.listConversationRecords() already sorts. Returns
// [{id, snippet}] for every conversation whose title or any message's text
// contains `query` as a case-insensitive substring. `snippet` prefers an
// excerpt from a matching message body over the title so a result shows
// *why* it matched, falling back to the title itself when only the title
// (and no message body) matched.
export function searchConversations(conversations, query) {
  const trimmed = (query || "").trim();
  if (!trimmed) return [];
  const needle = trimmed.toLowerCase();
  const results = [];
  for (const convo of conversations) {
    const title = convo.title || "";
    let snippet = null;
    for (const m of convo.messages || []) {
      snippet = extractSnippet(searchableText(m), trimmed);
      if (snippet) break;
    }
    const titleMatches = title.toLowerCase().includes(needle);
    if (snippet || titleMatches) {
      results.push({ id: convo.id, snippet: snippet || title });
    }
  }
  return results;
}
