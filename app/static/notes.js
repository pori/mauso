// Notes page -- CRUD over saved notes, stored in plaintext on this backend
// (see the privacy note on the page itself) so the search_notes tool can
// look them up. Unrelated to the conversation encryption in crypto.js.
import { renderMarkdown } from "./markdown.js";

const titleEl = document.getElementById("note_title");
const contentEl = document.getElementById("note_content");
const tagsEl = document.getElementById("note_tags");
const previewEl = document.getElementById("note-preview");
const idEl = document.getElementById("note_id");
const submitBtn = document.getElementById("note-submit-btn");
const cancelBtn = document.getElementById("note-cancel-btn");
const importInput = document.getElementById("note-import-input");
const tagFilterEl = document.getElementById("note-tag-filter");

let allNotes = [];

function updatePreview() {
  previewEl.innerHTML = renderMarkdown(contentEl.value);
}
contentEl.addEventListener("input", updatePreview);

// Strips the extension and swaps any filesystem-unfriendly char for "_" --
// used both ways: importing derives a title from a filename, downloading
// derives a filename from a title.
function sanitizeFilename(name) {
  return (name || "note").replace(/[^\w\- ]+/g, "_").trim() || "note";
}

function downloadText(filename, text, mimeType) {
  const blob = new Blob([text], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

importInput.addEventListener("change", async () => {
  const file = importInput.files[0];
  if (!file) return;
  if ((titleEl.value.trim() || contentEl.value.trim()) && !confirm("Replace the current draft with the imported file?")) {
    importInput.value = "";
    return;
  }
  const text = await file.text();
  idEl.value = ""; // imported files always start a new note, never silently overwrite a saved one
  titleEl.value = file.name.replace(/\.[^./\\]+$/, "");
  contentEl.value = text;
  updatePreview();
  submitBtn.textContent = "Add note";
  cancelBtn.style.display = "none";
  importInput.value = "";
  titleEl.focus();
});

document.getElementById("note-download-md-btn").addEventListener("click", () => {
  downloadText(`${sanitizeFilename(titleEl.value)}.md`, contentEl.value, "text/markdown");
});
document.getElementById("note-download-txt-btn").addEventListener("click", () => {
  downloadText(`${sanitizeFilename(titleEl.value)}.txt`, contentEl.value, "text/plain");
});

function resetForm() {
  idEl.value = "";
  titleEl.value = "";
  contentEl.value = "";
  tagsEl.value = "";
  updatePreview();
  submitBtn.textContent = "Add note";
  cancelBtn.style.display = "none";
}

function formatDate(iso) {
  if (!iso) return "";
  return new Date(iso).toLocaleString();
}

function populateTagFilter(notes) {
  const tags = new Set();
  for (const n of notes) {
    for (const t of n.tags || []) tags.add(t);
  }
  const current = tagFilterEl.value;
  tagFilterEl.innerHTML = '<option value="">All tags</option>';
  for (const t of [...tags].sort()) {
    const opt = document.createElement("option");
    opt.value = t;
    opt.textContent = t;
    tagFilterEl.appendChild(opt);
  }
  if (tags.has(current)) tagFilterEl.value = current;
}

function renderNoteList() {
  const filterTag = tagFilterEl.value;
  const notes = filterTag ? allNotes.filter((n) => (n.tags || []).includes(filterTag)) : allNotes;
  const list = document.getElementById("note-list");
  list.innerHTML = "";
  if (notes.length === 0) {
    list.innerHTML = `<p class="hint">${filterTag ? "No notes with that tag." : "No saved notes yet."}</p>`;
    return;
  }
  for (const n of notes) {
    const row = document.createElement("div");
    row.className = "profile-row note-row";

    const label = document.createElement("span");
    const snippet = (n.content_markdown || "").replace(/\s+/g, " ").trim().slice(0, 80);
    const tagsHtml = (n.tags || []).map((t) => `<span class="note-tag-chip">${t}</span>`).join(" ");
    label.innerHTML = `<strong>${n.title}</strong> ${tagsHtml}<br><span class="hint">${formatDate(n.updated_at)}${snippet ? " · " + snippet : ""}</span>`;
    row.appendChild(label);

    const editBtn = document.createElement("button");
    editBtn.type = "button";
    editBtn.textContent = "Edit";
    editBtn.addEventListener("click", () => {
      idEl.value = n.id;
      titleEl.value = n.title;
      contentEl.value = n.content_markdown || "";
      tagsEl.value = (n.tags || []).join(", ");
      updatePreview();
      submitBtn.textContent = "Save note";
      cancelBtn.style.display = "";
      titleEl.focus();
      titleEl.scrollIntoView({ behavior: "smooth", block: "center" });
    });
    row.appendChild(editBtn);

    const downloadMdBtn = document.createElement("button");
    downloadMdBtn.type = "button";
    downloadMdBtn.textContent = "↓ .md";
    downloadMdBtn.addEventListener("click", () => {
      downloadText(`${sanitizeFilename(n.title)}.md`, n.content_markdown || "", "text/markdown");
    });
    row.appendChild(downloadMdBtn);

    const downloadTxtBtn = document.createElement("button");
    downloadTxtBtn.type = "button";
    downloadTxtBtn.textContent = "↓ .txt";
    downloadTxtBtn.addEventListener("click", () => {
      downloadText(`${sanitizeFilename(n.title)}.txt`, n.content_markdown || "", "text/plain");
    });
    row.appendChild(downloadTxtBtn);

    const delBtn = document.createElement("button");
    delBtn.type = "button";
    delBtn.textContent = "Delete";
    delBtn.className = "btn-danger";
    delBtn.addEventListener("click", async () => {
      if (!confirm(`Delete note "${n.title}"?`)) return;
      await fetch(`/api/notes/${n.id}`, { method: "DELETE" });
      if (idEl.value == n.id) resetForm();
      await loadNotes();
    });
    row.appendChild(delBtn);

    list.appendChild(row);
  }
}

cancelBtn.addEventListener("click", resetForm);

document.getElementById("note-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const id = idEl.value;
  const body = { title: titleEl.value, content_markdown: contentEl.value, tags: tagsEl.value };
  await fetch(id ? `/api/notes/${id}` : "/api/notes", {
    method: id ? "PUT" : "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  resetForm();
  await loadNotes();
});

tagFilterEl.addEventListener("change", renderNoteList);

async function loadNotes() {
  const resp = await fetch("/api/notes");
  allNotes = await resp.json();
  populateTagFilter(allNotes);
  renderNoteList();
}

updatePreview();
loadNotes();
