'use strict';

// Just enough TOML to manage one [mcp_servers.<name>] table in Codex's
// config.toml without a TOML library (this package has no dependencies).
//
// The approach is line-based and deliberately narrow. The file is scanned to
// find where real table headers are — skipping anything inside multi-line
// strings, multi-line arrays and comments, where a line can look like a
// header without being one — and our server's table (plus any subtables of
// it) is cut out and written back as a whole. Every other line of the file is
// left exactly as it was. Forms of the same server this cannot edit safely
// (an inline mcp_servers table, dotted keys) are refused, not guessed at.

class TOMLConflictError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TOMLConflictError';
  }
}

const BARE_KEY = /^[A-Za-z0-9_-]+/;

function unescapeBasic(body) {
  return body.replace(/\\(u[0-9A-Fa-f]{4}|U[0-9A-Fa-f]{8}|.)/g, (_, e) => {
    switch (e[0]) {
      case 'b':
        return '\b';
      case 't':
        return '\t';
      case 'n':
        return '\n';
      case 'f':
        return '\f';
      case 'r':
        return '\r';
      case 'e':
        return '\x1b';
      case 'u':
      case 'U':
        return String.fromCodePoint(parseInt(e.slice(1), 16));
      default:
        return e; // \" and \\ (and anything else, verbatim)
    }
  });
}

// readString reads a single-line basic or literal string at s[i]. Returns
// { value, end } or null.
function readString(s, i) {
  if (s[i] === '"' && !s.startsWith('"""', i)) {
    let j = i + 1;
    while (j < s.length && s[j] !== '"') j += s[j] === '\\' ? 2 : 1;
    if (j >= s.length) return null;
    return { value: unescapeBasic(s.slice(i + 1, j)), end: j + 1 };
  }
  if (s[i] === "'" && !s.startsWith("'''", i)) {
    const j = s.indexOf("'", i + 1);
    if (j < 0) return null;
    return { value: s.slice(i + 1, j), end: j + 1 };
  }
  return null;
}

// readKeyPath reads a dotted key (bare or quoted segments) starting at s[i].
// Returns { path, end } or null.
function readKeyPath(s, i) {
  const path = [];
  for (;;) {
    while (s[i] === ' ' || s[i] === '\t') i++;
    const quoted = readString(s, i);
    if (quoted) {
      path.push(quoted.value);
      i = quoted.end;
    } else {
      const bare = BARE_KEY.exec(s.slice(i));
      if (!bare) return null;
      path.push(bare[0]);
      i += bare[0].length;
    }
    while (s[i] === ' ' || s[i] === '\t') i++;
    if (s[i] !== '.') return { path, end: i };
    i++;
  }
}

// scan classifies every line. A line is a header only when it starts at
// bracket depth zero outside any multi-line string.
function scan(text) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  const info = [];
  let ml = null; // '"""' or "'''" while inside a multi-line string
  let depth = 0; // [ and { nesting of a value spanning lines
  for (const line of lines) {
    const entry = { header: null, key: null };
    let i = 0;
    if (!ml && depth === 0) {
      const trimmed = line.trimStart();
      if (trimmed.startsWith('[')) {
        const array = trimmed.startsWith('[[');
        const parsed = readKeyPath(trimmed, array ? 2 : 1);
        if (parsed && trimmed.slice(parsed.end).startsWith(array ? ']]' : ']')) {
          entry.header = { path: parsed.path, array };
          info.push(entry);
          continue;
        }
      } else {
        const parsed = readKeyPath(line, 0);
        if (parsed && line[parsed.end] === '=') {
          entry.key = { path: parsed.path, valueStart: parsed.end + 1 };
          i = parsed.end + 1;
        }
      }
    }
    while (i < line.length) {
      if (ml) {
        // Basic strings can escape a quote; literal strings cannot.
        let j = i;
        while (j < line.length && !line.startsWith(ml, j)) j += ml === '"""' && line[j] === '\\' ? 2 : 1;
        if (j >= line.length) {
          i = line.length;
          break;
        }
        i = j + 3;
        // A closing delimiter may be followed by up to two more quotes.
        while (line[i] === ml[0]) i++;
        ml = null;
        continue;
      }
      const c = line[i];
      if (c === '#') break;
      if (line.startsWith('"""', i) || line.startsWith("'''", i)) {
        ml = line.slice(i, i + 3);
        i += 3;
        continue;
      }
      if (c === '"' || c === "'") {
        const str = readString(line, i);
        i = str ? str.end : line.length;
        continue;
      }
      if (c === '[' || c === '{') depth++;
      else if ((c === ']' || c === '}') && depth > 0) depth--;
      i++;
    }
    info.push(entry);
  }
  return { lines, info, eol };
}

function isBlank(line) {
  return line.trim() === '';
}

function isComment(line) {
  return line.trimStart().startsWith('#');
}

function ownsPath(path, name) {
  return path.length >= 2 && path[0] === 'mcp_servers' && path[1] === name;
}

// serverRanges returns [start, end) line ranges of the server's table and its
// subtables, in file order. Comment lines directly above the next header are
// left alone: they introduce that table, not ours.
function serverRanges(doc, name) {
  const ranges = [];
  const { lines, info } = doc;
  for (let h = 0; h < info.length; h++) {
    const header = info[h].header;
    if (!header || header.array || !ownsPath(header.path, name)) continue;
    let next = h + 1;
    while (next < info.length && !info[next].header) next++;
    let end = next;
    if (next < info.length) {
      while (end - 1 > h && isComment(lines[end - 1])) end--;
    }
    ranges.push([h, end]);
  }
  return ranges;
}

// checkConflicts refuses the shapes this editor cannot rewrite safely.
function checkConflicts(doc, name) {
  let table = []; // path of the table the current line belongs to
  for (const entry of doc.info) {
    if (entry.header) {
      table = entry.header.array ? null : entry.header.path;
      continue;
    }
    if (!entry.key || !table) continue;
    const full = table.concat(entry.key.path);
    if (full.length === 1 && full[0] === 'mcp_servers') {
      throw new TOMLConflictError('config.toml defines mcp_servers as an inline table; move it to [mcp_servers.<name>] tables and try again');
    }
    if (ownsPath(full, name) && !ownsPath(table, name)) {
      throw new TOMLConflictError(`config.toml defines mcp_servers.${name} with dotted keys or an inline table; remove that definition and try again`);
    }
  }
}

function tomlString(s) {
  return (
    '"' +
    s
      .replace(/[\\"]/g, (c) => '\\' + c)
      .replace(/[\u0000-\u001f\u007f]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0')) +
    '"'
  );
}

function tomlKey(k) {
  return /^[A-Za-z0-9_-]+$/.test(k) ? k : tomlString(k);
}

function render(doc, lines) {
  while (lines.length > 0 && isBlank(lines[lines.length - 1])) lines.pop();
  return lines.length === 0 ? '' : lines.join(doc.eol) + doc.eol;
}

function cut(doc, ranges) {
  const lines = doc.lines.slice();
  for (let r = ranges.length - 1; r >= 0; r--) {
    const [start, end] = ranges[r];
    lines.splice(start, end - start);
    // Do not leave two blank lines where the table used to be.
    while (start > 0 && start < lines.length && isBlank(lines[start - 1]) && isBlank(lines[start])) {
      lines.splice(start, 1);
    }
  }
  return lines;
}

// setServer returns text with [mcp_servers.<name>] replaced by a table holding
// fields (string values, or objects of string values written as inline
// tables). comment, if given, is written as the table's first line so it
// travels with the table when it is later replaced or removed.
function setServer(text, name, fields, { comment } = {}) {
  const doc = scan(text || '');
  checkConflicts(doc, name);
  const ranges = serverRanges(doc, name);
  const lines = cut(doc, ranges);
  let at = ranges.length > 0 ? ranges[0][0] : lines.length;
  while (at === lines.length && at > 0 && isBlank(lines[at - 1])) {
    lines.pop();
    at--;
  }
  const block = [`[mcp_servers.${tomlKey(name)}]`];
  if (comment) block.push(`# ${comment}`);
  for (const [key, value] of Object.entries(fields)) {
    if (typeof value === 'string') {
      block.push(`${tomlKey(key)} = ${tomlString(value)}`);
    } else {
      const pairs = Object.entries(value).map(([k, v]) => `${tomlString(k)} = ${tomlString(v)}`);
      block.push(`${tomlKey(key)} = { ${pairs.join(', ')} }`);
    }
  }
  if (at > 0 && !isBlank(lines[at - 1])) block.unshift('');
  if (at < lines.length && !isBlank(lines[at])) block.push('');
  lines.splice(at, 0, ...block);
  const out = render(doc, lines);
  const back = readServer(out, name);
  if (!back || JSON.stringify(back) !== JSON.stringify(fields)) {
    throw new Error('internal error: the edited config.toml did not read back as written');
  }
  return out;
}

function removeServer(text, name) {
  if (!text) return text;
  const doc = scan(text);
  const ranges = serverRanges(doc, name);
  if (ranges.length === 0) return text;
  return render(doc, cut(doc, ranges));
}

// readInlineValue reads a string or an inline table of strings.
function readInlineValue(s) {
  let i = 0;
  while (s[i] === ' ' || s[i] === '\t') i++;
  const str = readString(s, i);
  if (str) return str.value;
  if (s[i] !== '{') return undefined;
  i++;
  const out = {};
  for (;;) {
    while (s[i] === ' ' || s[i] === '\t' || s[i] === ',') i++;
    if (s[i] === '}') return out;
    const key = readKeyPath(s, i);
    if (!key || s[key.end] !== '=' || key.path.length !== 1) return undefined;
    i = key.end + 1;
    while (s[i] === ' ' || s[i] === '\t') i++;
    const value = readString(s, i);
    if (!value) return undefined;
    out[key.path[0]] = value.value;
    i = value.end;
  }
}

// readServer returns the server's simple fields ({url, http_headers, ...}) or
// null when the table is absent. Values this reader does not understand are
// left out rather than misread.
function readServer(text, name) {
  if (!text) return null;
  const doc = scan(text);
  const ranges = serverRanges(doc, name);
  if (ranges.length === 0) return null;
  const out = {};
  for (const [start, end] of ranges) {
    const sub = doc.info[start].header.path.slice(2);
    for (let l = start + 1; l < end; l++) {
      const key = doc.info[l].key;
      if (!key) continue;
      const value = readInlineValue(doc.lines[l].slice(key.valueStart));
      if (value === undefined) continue;
      const path = sub.concat(key.path);
      if (path.length === 1) {
        out[path[0]] = value;
      } else if (path.length === 2 && typeof value === 'string') {
        if (typeof out[path[0]] !== 'object') out[path[0]] = {};
        out[path[0]][path[1]] = value;
      }
    }
  }
  return out;
}

module.exports = { setServer, removeServer, readServer, TOMLConflictError, tomlString };
