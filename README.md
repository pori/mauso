# mauso

Agentic AI chat PoC. Point it at any OpenAI-compatible endpoint (a hosted
provider, or a self-hosted LiteLLM/Ollama) and chat with it, with six agent
skills wired up: image generation and image editing (both via a ComfyUI
instance you configure), in-chat notes generation, search over saved notes
(managed on the Notes page), RAG search over uploaded documents, and live
web search (via the Tavily API).

## Privacy model -- read this before assuming more is encrypted than is

**Conversation history is end-to-end encrypted in the browser** (Web
Crypto, AES-GCM-256, key derived via PBKDF2 from a passphrase you choose on
first visit) and stored **only** in that browser's IndexedDB. The
passphrase and derived key never leave the browser; this backend never
receives, stores, or logs either one, and never persists a conversation
transcript anywhere -- not even transiently to disk. If you clear that
browser's site data, or use a different browser/device, that history is
gone; there is no server-side copy or sync.

The derived key is also cached in `sessionStorage` for the tab's lifetime
(see `crypto.js`) so navigating between Chat/Files/Settings -- each a real
page load, not SPA routing -- doesn't re-prompt for the passphrase every
time. It's cleared when the tab/window closes, or immediately via the
sidebar's **Lock** button; it's never written to disk. This is exactly as
exposed to same-origin XSS as keeping the key only in a JS variable would
be (there's no untrusted third-party script on this page to begin with) --
a convenience tradeoff, not a weakening of the "passphrase never leaves the
browser" guarantee.

**What the backend *does* store in plaintext** on disk (`mauso-data`
volume), same as every other stack on this host:
- The configured LLM endpoint's **API key**, and the **Tavily API key**
  used by `web_search`, both encrypted at rest with `MAUSO_SECRET_KEY` (a
  *server*-held secret, unrelated to your conversation passphrase -- see
  `.env.example`).
- **Files you upload for the RAG skill**, plus their chunked text and
  embeddings. The backend has to read these to index and search them, so
  they cannot be end-to-end encrypted the way chat messages are. Don't
  upload anything here you wouldn't put in any other self-hosted app on
  this box.
- **Images**, whether you attach one for the edit_image skill to work on or
  the agent produces one via generate_image/edit_image. Same reasoning as
  above -- ComfyUI has to receive the actual bytes, so they're kept as
  plaintext blobs in the `chat_image` table (`app/models.py`), addressed by
  a numeric id (`/api/chat-images/{id}`). There's currently no delete
  endpoint for these -- they accumulate until the volume is wiped.
- **Notes you save on the Notes page**, so the `search_notes` skill can look
  them up in plaintext. This is separate from the in-chat "note" replies the
  model produces with `create_note`, which stay in the encrypted
  conversation and are never written here unless you copy them into a saved
  note yourself.

**During an active chat turn**, the plaintext of your messages (and the
LLM's replies) necessarily passes through this backend in memory, because
something has to call the configured LLM endpoint and run the tool loop.
That's an inherent property of "backend-mediated," not a bug -- see the
architecture note below if you want the alternative tradeoffs.

**web_search is the one skill that talks to a third party besides your
configured LLM/embedding endpoint.** When the model calls it, the query
text (not your full conversation) is sent to the Tavily API. Tavily
advertises zero-day retention on search terms as of this writing -- verify
their current policy yourself before relying on it for anything sensitive.

## Setup

1. `cp .env.example .env`, generate a `MAUSO_SECRET_KEY`
   (`python3 -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"`),
   fill it in, `chmod 600 .env`.
2. `docker compose up -d --build`. See the comments in `docker-compose.yml`
   for the external-network assumptions (an existing Docker network with
   your LLM endpoint and ComfyUI reachable on it) and how to override them.
3. Visit whatever hostname/URL you've routed to the container, choose a
   passphrase when prompted.
4. Go to **Settings**, set your endpoint's base URL (OpenAI-SDK
   convention -- normally already ends in `/v1`, e.g.
   `http://litellm:4000/v1` for a self-hosted LiteLLM on the same Docker
   network, or `https://api.openai.com/v1` for a hosted provider), API key
   if needed, chat model, and (optionally) an embedding model for RAG, a
   ComfyUI checkpoint name for image generation, and a Tavily API key for
   web_search.

## Skills

- **generate_image** -- calls a ComfyUI instance directly with a minimal
  built-in txt2img workflow (a fixed graph with prompt/checkpoint slots,
  not a custom node-graph editor). Requires a checkpoint filename in
  Settings that actually exists in that ComfyUI's models directory; if it
  doesn't (e.g. no weights installed yet), this skill fails with a clear
  error the model can surface, rather than crashing the whole turn.
- **edit_image** -- takes an existing image (one the agent previously
  generated/edited in this conversation, or one you attach via the 📎
  button next to the message box) plus a text instruction, and runs a
  generic ComfyUI img2img graph (LoadImage -> VAEEncode -> KSampler at
  partial denoise -> VAEDecode -> SaveImage) against it -- not a
  purpose-built edit workflow, just whatever the configured checkpoint does
  with a partial-denoise pass. Subject to the same checkpoint-must-exist
  requirement as generate_image. Images are referenced across turns by a
  small integer id (see the frontend's `[Image id=N: ...]` placeholders in
  what actually gets sent to the model) so the agent can chain edits.
- **create_note** -- asks the model to produce a structured Markdown note
  as a distinct message in the conversation. Purely a formatting
  convention -- it's stored (encrypted) exactly like any other message,
  no separate backend persistence.
- **search_notes** -- keyword search (plain substring match, no embeddings)
  over notes you create/edit/delete yourself on the Notes page. Unlike
  create_note, these persist in plaintext on the backend across
  conversations so the agent can be asked to reference them later.
- **search_documents** -- retrieval over files uploaded on the Files page,
  scoped to whichever documents are toggled "active" for the current
  conversation in the sidebar. Requires an embedding model configured in
  Settings.
- **web_search** -- live web search via the Tavily API for anything
  time-sensitive or outside the model's training data. Requires a Tavily
  API key configured in Settings; without one the tool returns an error the
  model can surface rather than failing the whole turn.

## Architecture note

This was scaffolded as "backend-mediated" on purpose: the skills above
(especially RAG, which needs server-side storage/embedding, and image
generation, which needs a reachable ComfyUI) don't fit a fully
client-side/zero-backend design. The tradeoff accepted here is that the
backend is a real trust boundary for API keys and in-flight message
content, same as it is for any self-hosted LLM app -- the boundary is "the
box," not "the app." If that tradeoff is ever
revisited, chat.py + agent.py + llm_client.py are the pieces that would
need to move client-side (would require solving CORS against arbitrary
third-party endpoints).
