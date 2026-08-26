// Minimal, dependency-free Markdown -> sanitized HTML for chat messages.
// Not a full CommonMark implementation -- covers the subset people/models
// actually write: paragraphs, headings, bold/italic/strikethrough, inline
// and fenced code, links, blockquotes, and flat (un)ordered lists. All text
// is HTML-escaped up front, so there's no script-injection path regardless
// of message content -- this is the only place chat text becomes innerHTML.

const ESCAPE_MAP = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ESCAPE_MAP[c]);
}

// http(s)/mailto/relative only -- blocks javascript:/data: etc in links.
function safeHref(url) {
  return /^(https?:|mailto:)/i.test(url) || /^[/#]/.test(url) ? url : null;
}

// A Private Use Area code point, built via fromCharCode rather than a
// source literal so nothing unusual ends up embedded in this file. Chat
// text never contains it, so it's a collision-free placeholder marker used
// below to protect code spans/blocks from further markdown processing.
const MARK = String.fromCharCode(0xe000);

// Inline spans within a single block (heading text, paragraph line, list
// item, ...). Input is raw (unescaped) text.
function renderInline(raw) {
  let s = escapeHtml(raw);

  const codeSpans = [];
  s = s.replace(/`([^`\n]+)`/g, (_, code) => {
    codeSpans.push(code);
    return `${MARK}C${codeSpans.length - 1}${MARK}`;
  });

  s = s.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (whole, text, url) => {
    const href = safeHref(url);
    return href ? `<a href="${href}" target="_blank" rel="noopener noreferrer">${text}</a>` : whole;
  });
  s = s.replace(/\*\*([^\n]+?)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/__([^\n]+?)__/g, "<strong>$1</strong>");
  s = s.replace(/~~([^\n]+?)~~/g, "<del>$1</del>");
  // Inner text may not start/end with whitespace -- keeps "5 * 3 ... * 2"
  // (spaced-out literal asterisks, e.g. in math) from being read as emphasis.
  s = s.replace(/(^|[^*])\*(\S(?:[^*\n]*\S)?)\*(?!\*)/g, "$1<em>$2</em>");
  s = s.replace(/(^|[^_])_(\S(?:[^_\n]*\S)?)_(?!_)/g, "$1<em>$2</em>");

  s = s.replace(new RegExp(`${MARK}C(\\d+)${MARK}`, "g"), (_, i) => `<code>${codeSpans[Number(i)]}</code>`);
  return s;
}

const FENCE_RE = /```([^\n`]*)\n([\s\S]*?)```/g;
const HEADING_RE = /^(#{1,6})\s+(.*)$/;
const HR_RE = /^(-{3,}|\*{3,}|_{3,})$/;
const QUOTE_RE = /^>\s?/;
const UL_RE = /^[-*+]\s+/;
const OL_RE = /^\d+\.\s+/;
const FENCE_PLACEHOLDER_RE = new RegExp(`^${MARK}B(\\d+)${MARK}$`);

// A line that can't continue the paragraph currently being accumulated --
// i.e. it starts some other block type.
function startsNewBlock(line) {
  return (
    line.trim() === "" ||
    FENCE_PLACEHOLDER_RE.test(line) ||
    HEADING_RE.test(line) ||
    QUOTE_RE.test(line) ||
    UL_RE.test(line) ||
    OL_RE.test(line) ||
    HR_RE.test(line.trim())
  );
}

function renderBlocks(text) {
  // Pull fenced code blocks out first so their content skips all further
  // block/inline parsing (including inside blockquotes/lists).
  const codeBlocks = [];
  const src = text.replace(FENCE_RE, (_, lang, code) => {
    codeBlocks.push({ lang: lang.trim(), code });
    return `\n${MARK}B${codeBlocks.length - 1}${MARK}\n`;
  });

  const lines = src.split("\n");
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    if (line.trim() === "") {
      i++;
      continue;
    }

    const fenceMatch = line.match(FENCE_PLACEHOLDER_RE);
    if (fenceMatch) {
      const { lang, code } = codeBlocks[Number(fenceMatch[1])];
      const cls = lang ? ` class="language-${escapeHtml(lang)}"` : "";
      out.push(`<pre><code${cls}>${escapeHtml(code.replace(/\n$/, ""))}</code></pre>`);
      i++;
      continue;
    }

    const headingMatch = line.match(HEADING_RE);
    if (headingMatch) {
      const level = headingMatch[1].length;
      out.push(`<h${level}>${renderInline(headingMatch[2])}</h${level}>`);
      i++;
      continue;
    }

    if (HR_RE.test(line.trim())) {
      out.push("<hr>");
      i++;
      continue;
    }

    if (QUOTE_RE.test(line)) {
      const quoted = [];
      while (i < lines.length && QUOTE_RE.test(lines[i])) {
        quoted.push(lines[i].replace(QUOTE_RE, ""));
        i++;
      }
      out.push(`<blockquote>${renderBlocks(quoted.join("\n"))}</blockquote>`);
      continue;
    }

    if (UL_RE.test(line)) {
      const items = [];
      while (i < lines.length && UL_RE.test(lines[i])) {
        items.push(`<li>${renderInline(lines[i].replace(UL_RE, ""))}</li>`);
        i++;
      }
      out.push(`<ul>${items.join("")}</ul>`);
      continue;
    }

    if (OL_RE.test(line)) {
      const items = [];
      while (i < lines.length && OL_RE.test(lines[i])) {
        items.push(`<li>${renderInline(lines[i].replace(OL_RE, ""))}</li>`);
        i++;
      }
      out.push(`<ol>${items.join("")}</ol>`);
      continue;
    }

    // Paragraph: consume consecutive lines until something ends it, joining
    // single newlines as <br> (chat text, not strict CommonMark -- people
    // don't type two trailing spaces for a line break).
    const paraLines = [];
    while (i < lines.length && !startsNewBlock(lines[i])) {
      paraLines.push(lines[i]);
      i++;
    }
    out.push(`<p>${paraLines.map(renderInline).join("<br>")}</p>`);
  }

  return out.join("");
}

export function renderMarkdown(text) {
  if (!text) return "";
  return renderBlocks(text);
}
