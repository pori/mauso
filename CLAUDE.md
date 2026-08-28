# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

If a `PROJECT_NOTES.md` is present locally, it's a maintained handoff doc with the full history, architecture rationale, and open items — more detailed than this file, but git-ignored/local-only, so it won't exist in every clone. `README.md` is the concise user-facing setup/privacy doc and is always present. Treat both as more authoritative than any summary here if they disagree.

## What this is

mauso: an agentic AI chat PoC. Point it at any OpenAI-compatible LLM endpoint and chat with it, with six tool-calling skills: `generate_image` / `edit_image` (via this host's ComfyUI), `create_note` (pure formatting, no storage), `search_notes` (keyword search over notes persisted via the Notes page), `search_documents` (RAG over uploaded files), and `web_search` (live search via the Tavily API). Plain FastAPI + server-rendered Jinja templates + vanilla JS/CSS — no frontend build step, no framework.

**The defining architectural fact**: conversation history is end-to-end encrypted in the browser (Web Crypto AES-GCM-256, key from a user passphrase via PBKDF2) and lives only in IndexedDB. This backend never receives, stores, or logs a conversation transcript — not even transiently. It *does* store, in plaintext on disk, the LLM provider's API key and the Tavily API key (both encrypted at rest with a separate server-held `MAUSO_SECRET_KEY`), uploaded RAG documents + their chunks/embeddings, images (uploaded or agent-generated), and notes saved via the Notes page. Read the "Privacy model" section of `README.md` before touching anything that looks like it persists chat content — the client owns all conversation persistence; the backend must stay blind to it by design, not by accident. Note that `web_search` is the one skill that sends data (the query text) to a third party besides the configured LLM endpoint.

## Commands

No linter is configured. Pre-rebuild sanity checks used in this project:

```bash
python3 -m py_compile app/*.py app/**/*.py
pip install -r requirements-dev.txt   # once, into a venv
pytest
```

The test suite (`tests/`) uses FastAPI's `TestClient` against a throwaway sqlite file (`tests/test.db`, never the real `/data/mauso.db`) — most tests don't need a Docker rebuild to run. `tests/conftest.py` sets `DB_PATH` before any `app.*` module is imported and gives every test a fresh, empty schema. `tests/test_encryption_boundary.py` is the load-bearing one: it asserts no `Message`/`Conversation`-shaped table ever gets added to `models.py`, and that a full `/api/chat` turn (with the LLM client mocked) leaves every table's row count unchanged — a regression there means conversation content started touching disk.

```bash
python3 scripts/mutation_gate.py            # gate: fails only on mutants surviving in files *this diff* touched
python3 scripts/mutation_gate.py --full      # audit: fails on any surviving mutant across all of app/
```

Mutation-testing (`mutmut`, pinned in `requirements-dev.txt`, config in `pyproject.toml`'s `[tool.mutmut]`, `mutate_only_covered_lines = true` so it only mutates lines the suite actually exercises) backs `scripts/mutation_gate.py`. The default mode is what a per-task gate should run: it fails only when a mutant survives in an `app/*.py` file the current diff (vs `--base-ref`, default `main`, plus any uncommitted/staged changes) actually touched — pre-existing gaps in code a task didn't touch don't block it. `--full` is for a periodic audit of the whole tree, not per-task gating. Known caveat: because coverage collection has to trace through `agent.py`'s async generator, the exact set of mutants mutmut generates has been observed to vary slightly between otherwise-identical runs (~1-8 survivors in `--full` mode across repeated runs against the same code) — treat a `--full` survivor list as a lead to investigate, not a precise count.

Run locally:

```bash
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000
```

Deploy (this is how it actually runs — a Docker Compose stack, no ports published, reachable only via this host's shared Caddy):

```bash
cp .env.example .env   # fill in MAUSO_SECRET_KEY, chmod 600 .env
docker compose up -d --build
```

Don't edit `.env` while `docker compose up` for this project is running — Compose resolves `.env` at invocation start.

**Any edit under `app/` (Python, templates, or `static/*`) requires `docker compose up -d --build` to reach the running container.** The Dockerfile `COPY`s `app/` into the image at build time (`docker-compose.yml` bind-mounts only the `mauso-data` volume for the sqlite DB, not the source tree), so the deployed container is a snapshot — a CSS/JS/template/Python change on disk does nothing to the live site until it's rebuilt and redeployed.

## Architecture

### Backend layout (`app/`)

- `main.py` — FastAPI app, mounts routers + `/static`, serves the 3 page routes (chat, files, settings).
- `config.py` — env-var-sourced `Settings` (paths, timeouts, `DEFAULT_CHAT_MODEL`). Per-provider values (endpoint URL, API key, chat/embedding model) are deliberately **not** here — those are runtime-editable via the Settings page, stored in the `app_setting` table (`settings_store.py`), and always win over the env var once set.
- `db.py` / `models.py` — SQLAlchemy, sqlite at `/data/mauso.db`. Tables: `AppSetting`, `Document`, `Chunk`, `Profile`, `ChatImage`, `Note`.
- `crypto.py` — Fernet encrypt/decrypt for **provider API keys** (LLM endpoint, Tavily). Unrelated to conversation encryption, which is entirely client-side (`static/crypto.js`).
- `llm_client.py` — OpenAI-compatible client: `chat_completion`, `chat_completion_stream`, `embed`, `list_models`.
- `agent.py` — the tool-calling loop, see below.
- `rag_store.py` — chunking + cosine-similarity search, pure Python, no vector DB.
- `chat_images.py` — shared `ChatImage` persistence helper.
- `tools/registry.py` — OpenAI function-calling schemas for all 6 skills. `tools/comfy_common.py` has shared ComfyUI submit/poll/upload plumbing used by both image tools. `tools/notes.py` has both `create_note` (formatting only) and `search_notes` (queries the `Note` table). `tools/web_search.py` calls the Tavily `/search` API directly (not the configured LLM endpoint) and needs its own API key from the Settings page.
- `routers/chat.py` — `POST /api/chat`, SSE streaming agent turn. `routers/settings_router.py`, `routers/files.py` (RAG upload/list/delete), `routers/images.py` (`ChatImage` blobs by id), `routers/notes_router.py` (`Note` CRUD), `routers/profiles.py` (`Profile` CRUD).

### The agent loop (`agent.run_agent_turn`)

1. Loop up to `MAX_AGENT_TOOL_ITERATIONS` (default 5): call `llm_client.chat_completion` (non-streaming, with tool schemas). No `tool_calls` in the response → break.
2. Per tool call: yield `tool_call` SSE event → execute → yield `tool_result` event → append a `role: "tool"` message → loop again.
3. Once the model stops calling tools: one more call, this time `chat_completion_stream` with no tools, for the final answer, yielding `token` events.

The two-call design (non-streaming for the tool-decision phase, a separate streaming call for the final answer) trades an extra LLM roundtrip for avoiding the complexity of reassembling partial `tool_calls` JSON across SSE chunks. `routers/chat.py` wraps the generator in a `StreamingResponse`; nothing server-side persists any of it.

### Images are UI-only artifacts referenced by id

Both agent-generated and user-uploaded images are addressed uniformly through `/api/chat-images/{id}` (a small integer id), so the agent can chain edits against "the image from a few turns ago." Since images/notes never round-trip back to the model automatically, `app.js`'s `toApiMessage()` inserts a `[Image id=N: ...]` / `[Note "..."]` text placeholder when building the API request, so the model can still reference them in later turns.

### Frontend (`app/static/`, `app/templates/`)

- `crypto.js` — Web Crypto + IndexedDB: derive/cache/restore the encryption key, encrypt/decrypt/store conversations. Key is cached in `sessionStorage` for the tab's lifetime (cleared on tab close or the sidebar Lock button) so navigating Chat/Files/Settings — real page loads, not SPA routing — doesn't re-prompt. PBKDF2-HMAC-SHA256 iteration count (`DEFAULT_ITERATIONS`) is persisted per-vault in the `meta` IndexedDB store the first time it's read after being set, rather than hardcoded, precisely so it *can* change over time without breaking old data: a brand-new vault gets the current default, while a pre-existing vault (salt already on disk, no count recorded yet) gets backfilled with the legacy value it was actually derived with. Bumping `DEFAULT_ITERATIONS` again later is safe by the same mechanism — it does not retroactively strengthen already-created vaults, since that needs a "rotate passphrase, re-encrypt everything" migration that doesn't exist yet.
- `theme.js` — loaded on every page: theme toggle + sidebar drawer wiring (shared chrome across all 3 pages).
- `app.js` — chat page: unlock flow, conversation CRUD, send/stream, message rendering.
- `base.html` owns the persistent sidebar shared across pages; `index.html` fills `sidebar_extra`/`sidebar_footer_extra` blocks for chat-specific sidebar content (conversation list, active documents, Lock). There's deliberately no "Chat" nav link — the sidebar/brand click already goes there.

## Conventions and gotchas worth knowing before editing the frontend

- All text inputs/selects are pinned to `font-size: 16px` explicitly — iOS Safari auto-zooms on focus below that.
- Icon-only controls are inline SVG (`stroke="currentColor"`), not emoji — emoji have inconsistent vertical metrics across fonts/OSes and broke centering. Every icon-only `<button>` needs explicit `padding: 0; line-height: 1;` (the global `button` rule's padding survives even a fixed width/height otherwise).
- The composer's controls row sits *underneath* the text input in one rounded pill, not beside it — single-row icon+input+button layouts were a recurring source of height/baseline mismatches here; this was a structural fix, not a CSS patch.
- To fade UI in/out without shifting layout (e.g. the per-message actions row), toggle `opacity`/`visibility`, not `display` — the box should always reserve its space.
- Assistant replies render full-width with a thin left rule, not a chat bubble (explicit user preference, Open WebUI-style, said to read better for long answers). User messages are bubbles. Notes render as their own bordered card, distinct from both.
- `MAX_AGENT_TOOL_ITERATIONS`, `RAG_CHUNK_CHARS`, `RAG_CHUNK_OVERLAP_CHARS`, `LLM_TIMEOUT`, `COMFYUI_TIMEOUT`, `MAX_UPLOAD_BYTES` are all env-configurable (`config.py`) rather than hardcoded.

## Known gaps (accepted, not oversights)

- `generate_image`/`edit_image` build the FLUX.2 Klein 9B Distilled workflow (UNETLoader/CLIPLoader(flux2)/VAELoader + RandomNoise/CFGGuider/SamplerCustomAdvanced, not a plain checkpoint+KSampler graph) against `flux-2-klein-9b-fp8.safetensors` on this host's ComfyUI — see `image_gen.py`/`image_edit.py`. The edit workflow conditions via `ReferenceLatent`, not partial-denoise img2img, so it has no `negative_prompt`/`denoise` knobs.
- No delete endpoint for `ChatImage` rows yet — they accumulate in the `mauso-data` volume.
- No automated test suite.
