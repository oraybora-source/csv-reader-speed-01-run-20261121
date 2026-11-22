// A fast drop-in for make.fun's csv-reader 1.0.0.
//
// Written in this session from the task's specification (RULES.txt and the
// bounty page): the text is read once, left to right, with commas and double
// quotes; a U+FEFF at the very start is dropped; a record ends at LF or CRLF;
// a line left with no characters is no record; outside quotes a CR not
// followed by LF is dropped (stray_cr); a field that opens with a quote runs
// to the next quote that is not doubled, "" inside it one quote and each CRLF
// or lone CR inside it read as LF; what follows its closing quote, up to the
// next comma or line break, is appended as it stands (quote_junk, when the
// field ends); a quote that never closes is a literal character, and the text
// after it is read again as unquoted (unterminated_quote); a quote inside an
// unquoted field is a literal character. Fields stay strings. columns is the
// first record when header is true, else null; rows holds the records after
// it, each padded (short_row) or cut (long_row) to the first record's width.
// Each error is {code, line, row}, in the order met.
//
// Strategy (why it is fast): the reference builds every field one character
// at a time. This reader instead takes whole lines and whole fields at once
// with indexOf/slice/split, and only falls back to a careful walk for the
// rare lines that hold a quote or a stray CR. Two paths:
//   - line path: a record whose line holds no quote and no stray CR is split
//     in one native call;
//   - field path: a record that needs care is parsed field by field, each
//     unquoted field taken as one slice between its delimiters, each quoted
//     field taken as one slice between its quotes (a slow walk only when the
//     quoted text holds a line break or a doubled quote).
// Pure: no clock, no randomness, no locale, nothing kept from one call to
// the next. Dependency-free ES module.

const COMMA = 0;
const LINE_BREAK = 1;
const END = 2;

/** csv-reader 1.0.0's answer for one case's input {text, header}. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  const n = text.length;
  let pos = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  let line = 1;

  // The record being read: the line it starts on and the index in rows it
  // takes (null: the header).
  let recordLine = 1;
  let recordRow = null;

  function error(code) {
    errors.push({ code, line: recordLine, row: recordRow });
  }

  // Counts how many times `ch` (a one-character string) occurs in `s`.
  function countOf(s, ch) {
    let count = 0;
    let at = s.indexOf(ch);
    while (at !== -1) {
      count += 1;
      at = s.indexOf(ch, at + 1);
    }
    return count;
  }

  // Counts the line breaks in a quoted value's raw text: each LF is one,
  // each CR is one, and a CRLF pair is one (not two).
  function countQuotedLines(s) {
    let lines = 0;
    let p = 0;
    while (true) {
      const r = s.indexOf('\r', p);
      const l = s.indexOf('\n', p);
      if (r === -1 && l === -1) return lines;
      if (r !== -1 && (l === -1 || r < l)) {
        lines += 1;
        p = r + (s.charCodeAt(r + 1) === 10 ? 2 : 1);
      } else {
        lines += 1;
        p = l + 1;
      }
    }
  }

  // A quoted value whose raw inner text `s` may hold CRs: each CRLF or lone
  // CR becomes one LF. Returns the value and adds the line breaks it holds
  // to the line count.
  function fixQuotedValue(s) {
    if (s.indexOf('\r') === -1) {
      line += countOf(s, '\n');
      return s;
    }
    line += countQuotedLines(s);
    // Every CR (alone or before LF) is one LF; an LF on its own stays.
    let out = '';
    let start = 0;
    let at = s.indexOf('\r');
    while (at !== -1) {
      out += s.slice(start, at) + '\n';
      start = at + (s.charCodeAt(at + 1) === 10 ? 2 : 1);
      at = s.indexOf('\r', start);
    }
    out += s.slice(start);
    return out;
  }

  // Reads an unquoted field onto `init`, up to the next comma or line break:
  // a CR not followed by LF is dropped (stray_cr). Returns the field, how it
  // ended, and how many characters were kept (`added`).
  function readUnquoted(init) {
    let end = n;
    let ended = END;
    const comma = text.indexOf(',', pos);
    if (comma !== -1) {
      end = comma;
      ended = COMMA;
    }
    const lf = text.indexOf('\n', pos);
    if (lf !== -1 && lf < end) {
      end = lf;
      ended = LINE_BREAK;
    }
    const seg = text.slice(pos, end);
    let value;
    let added;
    if (seg.indexOf('\r') === -1) {
      value = init.length !== 0 ? init + seg : seg;
      added = seg.length;
    } else {
      // Slow walk over this one short segment: every CR is stray, except a
      // CR at the very end of a segment that ends at a line break, which is
      // the CRLF of that break.
      let parts = null;
      let start = 0;
      let kept = 0;
      for (let i = 0; i < seg.length; i++) {
        if (seg.charCodeAt(i) === 13) {
          if (!(i === seg.length - 1 && ended === LINE_BREAK)) error('stray_cr');
          if (i > start) {
            if (parts === null) parts = [];
            parts.push(seg.slice(start, i));
            kept += i - start;
          }
          start = i + 1;
        }
      }
      if (start < seg.length) {
        if (parts === null) parts = [];
        parts.push(seg.slice(start));
        kept += seg.length - start;
      }
      const tail = parts === null ? '' : parts.join('');
      value = init.length !== 0 ? init + tail : tail;
      added = kept;
    }
    if (ended === COMMA) pos = end + 1;
    else if (ended === LINE_BREAK) {
      pos = end + 1;
      line += 1;
    } else {
      pos = end;
    }
    return { value, ended, added };
  }

  // Reads a quoted field whose opening quote is at pos.
  function readQuoted() {
    const open = pos;
    const openLine = line;
    pos += 1;
    let segStart = pos;
    let parts = null;
    let closedAt = -1;
    while (true) {
      const q = text.indexOf('"', pos);
      if (q === -1) break;
      if (text.charCodeAt(q + 1) === 34) {
        if (parts === null) parts = [];
        parts.push(text.slice(segStart, q));
        parts.push('"');
        pos = q + 2;
        segStart = pos;
        continue;
      }
      closedAt = q;
      break;
    }
    if (closedAt === -1) {
      // The quote never closes: it is a literal character, and the text
      // after it is read again as unquoted.
      pos = open + 1;
      line = openLine;
      error('unterminated_quote');
      return readUnquoted('"');
    }
    const last = text.slice(segStart, closedAt);
    let value;
    if (parts === null) {
      value = fixQuotedValue(last);
    } else {
      value = fixQuotedValue(parts.join('') + last);
    }
    pos = closedAt + 1;
    if (pos >= n) return { value, ended: END };
    const c = text[pos];
    if (c === ',') {
      pos += 1;
      return { value, ended: COMMA };
    }
    if (c === '\n') {
      pos += 1;
      line += 1;
      return { value, ended: LINE_BREAK };
    }
    if (c === '\r' && text.charCodeAt(pos + 1) === 10) {
      pos += 2;
      line += 1;
      return { value, ended: LINE_BREAK };
    }
    // What follows the closing quote is appended as it stands, up to the
    // next comma or line break.
    const junk = readUnquoted(value);
    if (junk.added > 0) error('quote_junk');
    return junk;
  }

  while (true) {
    // Lines with no characters are no records.
    while (pos < n) {
      if (text[pos] === '\n') {
        pos += 1;
        line += 1;
      } else if (text[pos] === '\r' && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= n) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;

    // Line path: this record's line, when it holds no quote and no stray CR,
    // splits in one native call. A line ends at the next LF; a CR right
    // before it is that line break's CRLF.
    let fields = null;
    const lfAt = text.indexOf('\n', pos);
    if (lfAt !== -1) {
      let lineEnd = lfAt;
      if (lineEnd > pos && text.charCodeAt(lineEnd - 1) === 13) lineEnd -= 1;
      const raw = text.slice(pos, lineEnd);
      if (raw.indexOf('"') === -1 && raw.indexOf('\r') === -1) {
        fields = raw.split(',');
        pos = lfAt + 1;
        line += 1;
      }
    }
    if (fields === null) {
      // Field path: parse field by field.
      fields = [];
      let field;
      let quoted = false;
      do {
        quoted = text[pos] === '"';
        field = quoted ? readQuoted() : readUnquoted('');
        fields.push(field.value);
      } while (field.ended === COMMA);
      // A record that ended at a comma at the end of the text leaves its
      // last field unquoted and empty, as the line path would.
      if (fields.length === 1 && fields[0] === '' && !quoted) continue;
      // (The skip above mirrors the reference: a line that held only stray
      // CRs is left with no characters and is no record.)
    } else if (fields.length === 1 && fields[0] === '') {
      // The line path only reaches here for a line that held only its CRLF
      // (raw '' after stripping the CR): no record, as above.
      continue;
    }

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
