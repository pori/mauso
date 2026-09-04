// Exercises the actual app/static/search.js (a real import, not a
// reimplementation). search.js is a dependency-free module -- no DOM, no
// network, no IndexedDB -- specifically so it's testable with Node's
// built-in test runner without any of the browser-only plumbing
// crypto_migration.test.mjs needs a fake IndexedDB for.
import assert from "node:assert/strict";
import { test } from "node:test";
import { extractSnippet, searchConversations } from "../../app/static/search.js";

test("extractSnippet finds a case-insensitive match and trims ellipses on both sides", () => {
  const text = "a".repeat(60) + "NEEDLE" + "b".repeat(60);
  const snippet = extractSnippet(text, "needle");
  assert.ok(snippet.startsWith("…"));
  assert.ok(snippet.endsWith("…"));
  assert.ok(snippet.toLowerCase().includes("needle"));
});

test("extractSnippet omits the ellipsis on a side that isn't cut off", () => {
  const snippet = extractSnippet("short needle text", "needle");
  assert.equal(snippet, "short needle text");
});

test("extractSnippet returns null for no match or empty input", () => {
  assert.equal(extractSnippet("hello world", "xyz"), null);
  assert.equal(extractSnippet("", "needle"), null);
  assert.equal(extractSnippet("hello", ""), null);
});

test("searchConversations matches a plain string message body, case-insensitively", () => {
  const conversations = [
    { id: "c1", title: "Untitled", messages: [{ role: "user", content: "what's the weather in Boston" }] },
    { id: "c2", title: "Untitled", messages: [{ role: "user", content: "tell me a joke" }] },
  ];
  const results = searchConversations(conversations, "BOSTON");
  assert.deepEqual(results.map((r) => r.id), ["c1"]);
  assert.ok(results[0].snippet.toLowerCase().includes("boston"));
});

test("searchConversations matches the title when no message body matches", () => {
  const conversations = [
    { id: "c1", title: "Trip to Boston", messages: [{ role: "user", content: "unrelated text" }] },
  ];
  const results = searchConversations(conversations, "boston");
  assert.deepEqual(results, [{ id: "c1", snippet: "Trip to Boston" }]);
});

test("searchConversations returns [] for an empty or whitespace-only query", () => {
  const conversations = [{ id: "c1", title: "hi", messages: [] }];
  assert.deepEqual(searchConversations(conversations, ""), []);
  assert.deepEqual(searchConversations(conversations, "   "), []);
});

test("searchConversations searches the text parts of a vision multi-part content array", () => {
  const conversations = [
    {
      id: "c1",
      title: "Untitled",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "what's in this photo of a lighthouse" },
            { type: "image_url", image_url: { url: "data:image/png;base64,xyz" } },
          ],
        },
      ],
    },
  ];
  const results = searchConversations(conversations, "lighthouse");
  assert.equal(results.length, 1);
  assert.ok(results[0].snippet.includes("lighthouse"));
});

test("searchConversations searches note and image tool-result message shapes", () => {
  const conversations = [
    { id: "note-convo", title: "Untitled", messages: [{ role: "assistant", kind: "note", title: "Recipe idea", content: "flour, sugar, eggs" }] },
    { id: "image-convo", title: "Untitled", messages: [{ role: "assistant", kind: "image", prompt: "a red bicycle", image_id: 1, image_url: "/api/chat-images/1" }] },
  ];
  assert.deepEqual(searchConversations(conversations, "sugar").map((r) => r.id), ["note-convo"]);
  assert.deepEqual(searchConversations(conversations, "bicycle").map((r) => r.id), ["image-convo"]);
});

test("searchConversations skips a conversation with no matches anywhere", () => {
  const conversations = [
    { id: "c1", title: "Untitled", messages: [{ role: "user", content: "nothing relevant here" }] },
  ];
  assert.deepEqual(searchConversations(conversations, "needle"), []);
});
