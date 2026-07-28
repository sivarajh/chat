// Message formatting: Slack-style rich text + safe auto-linking.
//
// SECURITY MODEL: message bodies are untrusted input from anyone in the group,
// so nothing here ever injects raw user HTML. Every message is escaped first;
// only a fixed whitelist of harmless inline tags is re-enabled afterwards, and
// those are re-emitted by name with no attributes at all. That makes
// <script>, <img onerror=...>, <iframe>, style="" and on* handlers impossible
// to smuggle through — they stay visible as plain text.
//
// NOTE: docs/format.js and public/format.js are intentionally identical so each
// deployment stays self-contained. Keep both in sync when editing.

// Inline tags a message may use. No attributes are ever preserved.
const ALLOWED_TAGS = "b|strong|i|em|u|s|strike|del|code|br";
// Matches a whitelisted tag even when the author attached attributes. Anything
// between the tag name and ">" is captured only so it can be thrown away — the
// replacement re-emits the bare tag name and nothing else.
const ALLOWED_TAG_RE = new RegExp(
  `&lt;(\\/?)(${ALLOWED_TAGS})\\b(?:(?!&gt;).)*?&gt;`,
  "gi"
);

// http(s) links, bare www. links, and email addresses.
const LINK_RE =
  /\b(?:https?:\/\/|www\.)[^\s<]+|[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/gi;

// Fenced ``` blocks and single-backtick spans.
const CODE_RE = /```\r?\n?([\s\S]*?)```|`([^`\n]+)`/g;

export function escapeHtml(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

// Turn one message body into display HTML.
export function formatMessage(raw) {
  // Strip NULs so they can't collide with our internal placeholders.
  const text = String(raw == null ? "" : raw).replace(/\u0000/g, "");

  // Finished HTML fragments (code spans, links) are parked here so later
  // passes can't reformat their contents. Restored in one go at the end.
  const stash = [];
  const park = (html) => `\u0000${stash.push(html) - 1}\u0000`;

  // Pass 1: split out code spans; format everything between them.
  let out = "";
  let last = 0;
  let m;
  CODE_RE.lastIndex = 0;
  while ((m = CODE_RE.exec(text)) !== null) {
    out += formatChunk(text.slice(last, m.index), park);
    out += m[1] !== undefined
      ? park(`<code class="block">${escapeHtml(m[1].replace(/\r?\n$/, ""))}</code>`)
      : park(`<code>${escapeHtml(m[2])}</code>`);
    last = CODE_RE.lastIndex;
  }
  out += formatChunk(text.slice(last), park);

  // Pass 2: put the parked fragments back.
  return out.replace(/\u0000(\d+)\u0000/g, (_, i) => stash[Number(i)]);
}

// Format a run of text that contains no code spans.
function formatChunk(chunk, park) {
  if (!chunk) return "";
  let s = escapeHtml(chunk);

  // Re-enable the whitelisted tags, dropping anything else (including any
  // attributes the author tried to attach).
  s = s.replace(ALLOWED_TAG_RE, (_, slash, tag) => `<${slash}${tag.toLowerCase()}>`);

  // Links become finished <a> fragments immediately so the markup passes below
  // can't mangle URLs containing _ * ~ or >.
  s = s.replace(LINK_RE, (match) => {
    const { url, tail } = splitTrailingPunctuation(match);
    if (!url) return match;
    const href = url.startsWith("http") ? url
      : url.includes("@") ? `mailto:${url}`
      : `https://${url}`;
    return park(
      `<a href="${href}" target="_blank" rel="noopener noreferrer">${url}</a>`
    ) + tail;
  });

  // > quoted lines. The trailing newline is consumed because .quote is a block.
  s = s.replace(/^&gt;[ \t]?(.*)(?:\r?\n|$)/gm, (_, q) => `<span class="quote">${q}</span>`);

  // *bold*, _italic_, ~strike~ — each marker must hug non-space text, so
  // "2 * 3 * 4" and mid_word underscores are left alone.
  s = s.replace(/\*([^\s*][^*\n]*?|[^\s*])\*/g, "<strong>$1</strong>");
  s = s.replace(
    /(^|[\s.,(!?])_([^\s_][^_\n]*?|[^\s_])_(?=$|[\s.,!?)])/g,
    "$1<em>$2</em>"
  );
  s = s.replace(/~([^\s~][^~\n]*?|[^\s~])~/g, "<del>$1</del>");

  return s;
}

// Trailing punctuation shouldn't be swallowed into a link: "see http://x.com."
// should link http://x.com and leave the period outside.
function splitTrailingPunctuation(match) {
  let url = match;
  let tail = "";
  for (;;) {
    // An escaped entity (&quot; &#39; …) is never part of the URL.
    const entity = url.match(/(&(?:amp|quot|#39|lt|gt);)$/);
    if (entity) {
      tail = entity[1] + tail;
      url = url.slice(0, -entity[1].length);
      continue;
    }
    const punct = url.match(/[.,!?;:'"]$/);
    if (punct) {
      tail = punct[0] + tail;
      url = url.slice(0, -1);
      continue;
    }
    // Keep balanced brackets (wiki-style URLs), drop unbalanced ones.
    const closer = url.match(/[)\]}]$/);
    if (closer) {
      const opener = { ")": "(", "]": "[", "}": "{" }[closer[0]];
      const opens = url.split(opener).length - 1;
      const closes = url.split(closer[0]).length - 1;
      if (closes > opens) {
        tail = closer[0] + tail;
        url = url.slice(0, -1);
        continue;
      }
    }
    break;
  }
  return { url, tail };
}
