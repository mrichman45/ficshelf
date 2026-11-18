// Library search, Calibre style. Plain words must all appear somewhere
// (title, author, series, folder or tags). Fields narrow it down:
//
//   tag:angst  author:"terry pratchett"  series:discworld  title:moon
//   format:cbz  format:podfic  status:finished  rating:>=4  rating:none
//   folder:manga  missing:yes  locked:yes  ao3:yes  new:yes
//
// A "-" in front turns any of them round (-tag:dark, -status:finished).
// Quotes keep words together. Upper or lower case does not matter.

const FIELDS = new Set([
  "tag", "tags", "author", "by", "series", "title", "format", "status",
  "rating", "stars", "folder", "missing", "locked", "drm", "ao3", "new", "updated",
]);

/// Split a query into terms: { field, value, negate }. A field nobody knows
/// (a word with a colon, like a time "3:00") is treated as plain text.
export function parseQuery(text) {
  const terms = [];
  const re = /(-?)(?:([a-z]+):)?(?:"([^"]*)"?|(\S*))/gi;
  let m;
  while ((m = re.exec(text || ""))) {
    if (m[0] === "") {
      re.lastIndex++; // an empty match between spaces: move on
      continue;
    }
    const negate = m[1] === "-";
    let field = (m[2] || "").toLowerCase();
    let value = (m[3] ?? m[4] ?? "").trim();
    if (field && !FIELDS.has(field)) {
      value = `${m[2]}:${value}`;
      field = "";
    }
    if (!value && !field) continue;
    terms.push({ field, value: value.toLowerCase(), negate });
  }
  return terms;
}

/// Her read status, or what it amounts to when she has not set one.
export function readStatus(book) {
  return book.status || (book.last_opened_at ? "reading" : "unread");
}

const yes = (v) => ["yes", "true", "y", "1", ""].includes(v);

function ratingMatches(book, value) {
  const r = book.rating || 0;
  if (value === "none" || value === "0") return r === 0;
  if (value === "any") return r > 0;
  const m = value.match(/^(<=|>=|<|>|=)?\s*(\d)$/);
  if (!m) return false;
  const n = Number(m[2]);
  switch (m[1]) {
    case ">=": return r >= n;
    case "<=": return r > 0 && r <= n;
    case ">": return r > n;
    case "<": return r > 0 && r < n;
    default: return r === n;
  }
}

function termMatches(book, { field, value }) {
  const has = (s) => (s || "").toLowerCase().includes(value);
  const tags = (book.tags || []).map((t) => t.toLowerCase());
  switch (field) {
    case "":
      return [book.title, book.author, book.series, book.folder].some(has) || tags.some((t) => t.includes(value));
    case "tag":
    case "tags":
      // tag:x matches the tag x exactly; tag:x* any tag starting with x.
      if (value.endsWith("*")) return tags.some((t) => t.startsWith(value.slice(0, -1)));
      return value ? tags.includes(value) : tags.length > 0;
    case "author":
    case "by":
      return has(book.author);
    case "series":
      return value ? has(book.series) : Boolean(book.series);
    case "title":
      return has(book.title);
    case "folder":
      return has(book.folder);
    case "format": {
      const f = (book.format || "").toLowerCase();
      if (value === "podfic" || value === "audio") return f === "audio";
      if (value === "comic" || value === "manga") return f === "cbz";
      return f === value;
    }
    case "status":
      return readStatus(book).startsWith(value);
    case "rating":
    case "stars":
      return ratingMatches(book, value);
    case "missing":
      return Boolean(book.missing) === yes(value);
    case "locked":
    case "drm":
      return Boolean(book.drm) === yes(value);
    case "ao3":
      return (book.ao3_work_id != null) === yes(value);
    case "new":
    case "updated":
      return Boolean(book.has_update) === yes(value);
    default:
      return false;
  }
}

/// Whether a book matches every term of a parsed query.
export function matchesQuery(book, terms) {
  return terms.every((t) => termMatches(book, t) !== t.negate);
}
