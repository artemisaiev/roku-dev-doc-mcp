/**
 * Markdown section handling.
 *
 * Upstream doc sizes are extremely skewed: most are a few KB, but the largest
 * is ~354 KB (roughly 90k tokens). Returning one of those whole would swamp a
 * caller's context window, so large docs are served as an outline plus a
 * requested section.
 */

/**
 * Docs at or below this size are returned whole; larger ones return an outline.
 *
 * 12 KB (~3k tokens) is the measured break-even against this corpus. Below it,
 * an outline saves so few tokens that the extra round trip costs more than it
 * saves — and the high-frequency lookups (BrightScript components median ~1.4 KB,
 * interfaces ~3.3 KB) sit well under, so they still arrive in one call. Above it,
 * whole-doc returns run to 7-22k tokens, and search already names the matching
 * section, so reading one costs no extra round trip when arriving from a search.
 *
 * Override with ROKU_DOCS_MCP_MAX_DOC_BYTES for a tighter or looser budget.
 */
export const WHOLE_DOC_LIMIT = envInt('ROKU_DOCS_MCP_MAX_DOC_BYTES', 12_000, 1_000, 500_000);

/** Hard ceiling on any single response body, even for one section or `full: true`. */
export const SECTION_HARD_LIMIT = envInt('ROKU_DOCS_MCP_MAX_SECTION_BYTES', 60_000, 2_000, 2_000_000);

/**
 * Read a positive integer from the environment, clamped to a sane range.
 * @param {string} name
 * @param {number} fallback
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
function envInt(name, fallback, min, max) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/**
 * Split markdown into sections on ATX headings, ignoring headings that fall
 * inside fenced code blocks (BrightScript samples routinely contain `#`).
 *
 * @param {string} markdown
 * @returns {{index:number, level:number, title:string, anchor:string, content:string, bytes:number}[]}
 */
export function splitSections(markdown) {
  const text = String(markdown ?? '');
  const lines = text.split('\n');

  /** @type {{level:number,title:string,line:number}[]} */
  const headings = [];
  let fence = null; // { char: '`'|'~', len: number }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    const fenceMatch = /^[ \t]{0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fenceMatch) {
      const char = fenceMatch[1][0];
      const len = fenceMatch[1].length;
      if (!fence) {
        // An opening fence may carry an info string; a closing one may not.
        fence = { char, len };
      } else if (char === fence.char && len >= fence.len && !fenceMatch[2].trim()) {
        fence = null;
      }
      continue;
    }
    if (fence) continue;

    const h = /^[ \t]{0,3}(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/.exec(line);
    if (h) headings.push({ level: h[1].length, title: h[2].trim(), line: i });
  }

  if (headings.length === 0) {
    const content = text.trim();
    return content
      ? [
          {
            index: 1,
            level: 0,
            title: '(document)',
            anchor: '',
            content,
            bytes: Buffer.byteLength(content),
          },
        ]
      : [];
  }

  const sections = [];

  // Any prose before the first heading becomes a leading section.
  const preamble = lines.slice(0, headings[0].line).join('\n').trim();
  if (preamble) {
    sections.push({
      index: 0,
      level: 0,
      title: '(intro)',
      anchor: '',
      content: preamble,
      bytes: Buffer.byteLength(preamble),
    });
  }

  for (let h = 0; h < headings.length; h++) {
    const start = headings[h].line;
    const end = h + 1 < headings.length ? headings[h + 1].line : lines.length;
    const content = lines.slice(start, end).join('\n').trim();
    sections.push({
      index: 0,
      level: headings[h].level,
      title: headings[h].title,
      anchor: slugify(headings[h].title),
      content,
      bytes: Buffer.byteLength(content),
    });
  }

  return sections.map((s, i) => ({ ...s, index: i + 1 }));
}

/**
 * A compact outline of a document's sections, for the model to pick from.
 * @param {ReturnType<typeof splitSections>} sections
 * @returns {string}
 */
export function buildToc(sections) {
  return sections
    .map((s) => {
      const indent = '  '.repeat(Math.max(0, s.level - 1));
      return `${String(s.index).padStart(3)}. ${indent}${s.title}  (${formatBytes(s.bytes)})`;
    })
    .join('\n');
}

/**
 * Resolve a section selector: a 1-based index, an exact/heading-slug match, or
 * a case-insensitive substring of the heading.
 *
 * @param {ReturnType<typeof splitSections>} sections
 * @param {string|number} selector
 * @returns {{index:number, level:number, title:string, anchor:string, content:string, bytes:number}|undefined}
 */
export function selectSection(sections, selector) {
  if (selector === undefined || selector === null || selector === '') return undefined;

  const raw = String(selector).trim();
  if (/^\d+$/.test(raw)) {
    return sections.find((s) => s.index === Number(raw));
  }

  const needle = raw.toLowerCase();
  const slug = slugify(raw);
  return (
    sections.find((s) => s.title.toLowerCase() === needle) ||
    sections.find((s) => s.anchor && s.anchor === slug) ||
    sections.find((s) => s.title.toLowerCase().includes(needle))
  );
}

/**
 * Pick the section most likely to contain what the user searched for, so a
 * search hit in a huge doc can point at the right part of it.
 * @param {ReturnType<typeof splitSections>} sections
 * @param {string} query
 * @returns {number|undefined} 1-based section index
 */
export function findSectionFor(sections, query) {
  const terms = String(query || '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}_]+/u)
    .filter((t) => t.length > 2);
  if (terms.length === 0) return undefined;

  let best;
  let bestScore = 0;
  for (const s of sections) {
    const hay = `${s.title}\n${s.content}`.toLowerCase();
    let score = 0;
    for (const t of terms) {
      if (s.title.toLowerCase().includes(t)) score += 5;
      if (hay.includes(t)) score += 1;
    }
    if (score > bestScore) {
      bestScore = score;
      best = s.index;
    }
  }
  return best;
}

/**
 * Truncate to a byte budget on a line boundary, appending a marker.
 * @param {string} text
 * @param {number} limit
 * @returns {{text:string, truncated:boolean}}
 */
export function clamp(text, limit = SECTION_HARD_LIMIT) {
  if (Buffer.byteLength(text) <= limit) return { text, truncated: false };
  let out = Buffer.from(text).subarray(0, limit).toString('utf8');
  const lastBreak = out.lastIndexOf('\n');
  if (lastBreak > limit * 0.6) out = out.slice(0, lastBreak);
  return { text: out.trimEnd(), truncated: true };
}

/**
 * Heading anchor used for matching a user-supplied section name. Close to
 * GitHub's scheme but collapses whitespace runs to a single hyphen, which
 * makes loose input easier to match; it is never used as a real URL fragment.
 */
export function slugify(title) {
  return String(title)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .trim()
    .replace(/\s+/g, '-');
}

export function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}
