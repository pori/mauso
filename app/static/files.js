// Files page -- uploads go to this backend in plaintext (see the privacy
// note on the page itself and in README.md); this is unrelated to the
// conversation encryption in crypto.js.

async function refresh() {
  const resp = await fetch("/api/files");
  const files = await resp.json();
  const list = document.getElementById("file-list");
  list.innerHTML = "";
  if (files.length === 0) {
    list.innerHTML = '<p class="hint">No files uploaded yet.</p>';
    return;
  }
  for (const f of files) {
    const row = document.createElement("div");
    row.className = "file-row";
    const status = f.status === "failed" ? `failed: ${f.error}` : f.status;
    row.innerHTML = `
      <span class="file-name">${f.filename}</span>
      <span class="file-meta">${(f.size_bytes / 1024).toFixed(1)} KB · ${f.chunk_count} chunks · ${status}</span>
    `;
    const delBtn = document.createElement("button");
    delBtn.textContent = "Delete";
    delBtn.className = "btn-danger";
    delBtn.addEventListener("click", async () => {
      await fetch(`/api/files/${f.id}`, { method: "DELETE" });
      refresh();
    });
    row.appendChild(delBtn);
    list.appendChild(row);
  }
}

document.getElementById("upload-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = document.getElementById("file-input");
  if (!input.files.length) return;
  const statusEl = document.getElementById("upload-status");
  for (const file of input.files) {
    statusEl.textContent = `Uploading ${file.name}...`;
    const form = new FormData();
    form.append("file", file);
    const resp = await fetch("/api/files", { method: "POST", body: form });
    const result = await resp.json();
    if (result.status === "failed") {
      statusEl.textContent = `${file.name}: ${result.error}`;
    }
  }
  statusEl.textContent = "";
  input.value = "";
  refresh();
});

refresh();
