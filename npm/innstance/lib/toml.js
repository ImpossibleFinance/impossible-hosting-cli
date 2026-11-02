'use strict';

// Just enough TOML to manage one [mcp_servers.<name>] table in Codex's
// config.toml without a TOML library (this package has no dependencies).
//
// The approach is line-based and deliberately narrow. The file is scanned to
// find where real table headers are — skipping anything inside multi-line
// strings, multi-line arrays and comments, where a line can look like a
// header without being one. Two edits are offered. updateServer changes the
// url and Authorization lines of a table that is already there and touches
// no other line, so whatever else the person set on the server (enabled,
// tool approvals, timeouts, per-tool subtables) survives a token refresh.
// setServer writes a whole new table, for a first install or --force. Every
// line outside the edit is left exactly as it was, line ending included.
// Forms of the same server this cannot edit safely (an inline mcp_servers
// table, dotted keys, a value spanning lines) are refused, not guessed at.

class TOMLConflictError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TOMLConflictError';
  }
}

const BARE_KEY = /^[A-Za-z0-9_-]+/;

// Keys are copied out of someone else's file into plain objects, so they are
// defined as own properties: a table named [mcp_servers.x.__proto__] stays
// data and never reaches Object.prototype.
function define(obj, key, value) {
  Object.defineProperty(obj, key, { value, enumerable: true, writable: true, configurable: true });
}

function own(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

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

// splitRows splits text into lines that each remember their own ending, so
// a file with mixed endings, or none on its last line, is written back the
// same way. eol is the file's usual ending, used for lines this module adds.
function splitRows(text) {
  const rows = [];
  const re = /\r?\n/g;
  let last = 0;
  let m;
  while ((m = re.exec(text))) {
    rows.push({ text: text.slice(last, m.index), end: m[0] });
    last = m.index + m[0].length;
  }
  if (last < text.length) rows.push({ text: text.slice(last), end: '' });
  const crlf = rows.filter((r) => r.end === '\r\n').length;
  const lf = rows.filter((r) => r.end === '\n').length;
  return { rows, eol: crlf > lf ? '\r\n' : '\n' };
}

// scan classifies every line. A line is a header only when it starts at
// bracket depth zero outside any multi-line string; continued marks a line
// that begins inside such a value, where "#" or "[" mean nothing.
function scan(text) {
  const { rows, eol } = splitRows(text);
  const info = [];
  let ml = null; // '"""' or "'''" while inside a multi-line string
  let depth = 0; // [ and { nesting of a value spanning lines
  for (const { text: line } of rows) {
    const entry = { header: null, key: null, continued: Boolean(ml) || depth > 0 };
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
  return { rows, info, eol };
}

function isBlank(line) {
  return line.trim() === '';
}

function isComment(line) {
  return line.trimStart().startsWith('#');
}

// isContent is a line that belongs to whatever table it sits in: a key, a
// value carried over from the line before, or anything that is not blank or
// a comment.
function isContent(doc, l) {
  const line = doc.rows[l].text;
  return !isBlank(line) && (doc.info[l].continued || !isComment(line));
}

function ownsPath(path, name) {
  return path.length >= 2 && path[0] === 'mcp_servers' && path[1] === name;
}

function isMainTable(path, name) {
  return path.length === 2 && ownsPath(path, name);
}

// serverRanges returns [start, end) line ranges of the server's table and its
// subtables, in file order. A range ends at the table's last key or value:
// comments and blank lines after it, before the next header or at the end of
// the file, are not part of the table (they introduce the next table, or are
// the person's notes) and are left where they are.
function serverRanges(doc, name) {
  const ranges = [];
  const { info } = doc;
  for (let h = 0; h < info.length; h++) {
    const header = info[h].header;
    if (!header || header.array || !ownsPath(header.path, name)) continue;
    let next = h + 1;
    while (next < info.length && !info[next].header) next++;
    let end = next;
    while (end - 1 > h && !isContent(doc, end - 1)) end--;
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

function inlineTable(pairs) {
  return `{ ${pairs.map(([k, v]) => `${tomlString(k)} = ${tomlString(v)}`).join(', ')} }`;
}

function newRow(doc, text) {
  return { text, end: doc.eol };
}

// render joins the rows back up. Every line keeps its own ending; one that
// had none (the old last line) gets the file's usual ending only when
// something now follows it.
function render(doc, rows) {
  let out = '';
  for (let r = 0; r < rows.length; r++) {
    const end = rows[r].end || (r < rows.length - 1 ? doc.eol : '');
    out += rows[r].text + end;
  }
  return out;
}

function cut(doc, ranges) {
  const rows = doc.rows.slice();
  for (let r = ranges.length - 1; r >= 0; r--) {
    const [start, end] = ranges[r];
    rows.splice(start, end - start);
    // Do not leave two blank lines where the table used to be, nor blank
    // lines at either end of the file that only separated it from the rest.
    while (start > 0 && start < rows.length && isBlank(rows[start - 1].text) && isBlank(rows[start].text)) {
      rows.splice(start, 1);
    }
    if (start === rows.length) {
      while (rows.length > 0 && isBlank(rows[rows.length - 1].text)) rows.pop();
    } else if (start === 0) {
      while (rows.length > 0 && isBlank(rows[0].text)) rows.shift();
    }
  }
  return rows;
}

// setServer returns text with [mcp_servers.<name>] replaced by a table holding
// fields (string values, or objects of string values written as inline
// tables). comment, if given, is written as the table's first line so it
// travels with the table when it is later replaced or removed.
function setServer(text, name, fields, { comment } = {}) {
  const doc = scan(text || '');
  checkConflicts(doc, name);
  const ranges = serverRanges(doc, name);
  const rows = cut(doc, ranges);
  let at = ranges.length > 0 ? ranges[0][0] : rows.length;
  while (at === rows.length && at > 0 && isBlank(rows[at - 1].text)) {
    rows.pop();
    at--;
  }
  const block = [`[mcp_servers.${tomlKey(name)}]`];
  if (comment) block.push(`# ${comment}`);
  for (const [key, value] of Object.entries(fields)) {
    if (typeof value === 'string') {
      block.push(`${tomlKey(key)} = ${tomlString(value)}`);
    } else {
      block.push(`${tomlKey(key)} = ${inlineTable(Object.entries(value))}`);
    }
  }
  if (at > 0 && !isBlank(rows[at - 1].text)) block.unshift('');
  if (at < rows.length && !isBlank(rows[at].text)) block.push('');
  rows.splice(at, 0, ...block.map((line) => newRow(doc, line)));
  const out = render(doc, rows);
  const back = readServer(out, name);
  if (!back || JSON.stringify(back) !== JSON.stringify(fields)) {
    throw new Error('internal error: the edited config.toml did not read back as written');
  }
  return out;
}

// readInline reads a single-line string, or an inline table of strings, at
// s[i]. Returns { value, end, table } (an inline table's value is its [key,
// value] pairs in file order) or null for anything else.
function readInline(s, i) {
  while (s[i] === ' ' || s[i] === '\t') i++;
  const str = readString(s, i);
  if (str) return { value: str.value, end: str.end, table: false };
  if (s[i] !== '{') return null;
  i++;
  const pairs = [];
  for (;;) {
    while (s[i] === ' ' || s[i] === '\t' || s[i] === ',') i++;
    if (s[i] === '}') return { value: pairs, end: i + 1, table: true };
    const key = readKeyPath(s, i);
    if (!key || s[key.end] !== '=' || key.path.length !== 1) return null;
    i = key.end + 1;
    while (s[i] === ' ' || s[i] === '\t') i++;
    const value = readString(s, i);
    if (!value) return null;
    pairs.push([key.path[0], value.value]);
    i = value.end;
  }
}

function pairsToObject(pairs) {
  const out = {};
  for (const [k, v] of pairs) define(out, k, v);
  return out;
}

// readInlineValue reads a string or an inline table of strings.
function readInlineValue(s) {
  const got = readInline(s, 0);
  if (!got) return undefined;
  return got.table ? pairsToObject(got.value) : got.value;
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
      const value = readInlineValue(doc.rows[l].text.slice(key.valueStart));
      if (value === undefined) continue;
      const path = sub.concat(key.path);
      if (path.length === 1) {
        define(out, path[0], value);
      } else if (path.length === 2 && typeof value === 'string') {
        let inner = own(out, path[0]) ? out[path[0]] : undefined;
        if (!inner || typeof inner !== 'object') {
          inner = {};
          define(out, path[0], inner);
        }
        define(inner, path[1], value);
      }
    }
  }
  return out;
}

const isAuthorization = (k) => k.toLowerCase() === 'authorization';

// editableValue reads the value of key line l when it can be replaced in
// place: a single-line string or inline table, followed by nothing but an
// optional comment. Anything else (a multi-line string or array, a number)
// is refused rather than half-rewritten.
function editableValue(doc, l, what) {
  const line = doc.rows[l].text;
  const start = doc.info[l].key.valueStart;
  const got = readInline(line, start);
  if (!got || !/^[ \t]*(#.*)?$/.test(line.slice(got.end))) {
    throw new TOMLConflictError(`config.toml writes ${what} in a form this tool cannot rewrite safely; remove that line and try again`);
  }
  return { ...got, prefix: line.slice(0, start), suffix: line.slice(got.end) };
}

// updateServer points an existing [mcp_servers.<name>] table at url with the
// given Authorization header value, changing only the lines that hold them.
// Every other line of the table and its subtables stays as it was. Returns
// null when there is no such table (setServer creates one).
function updateServer(text, name, { url, authorization }) {
  if (!text) return null;
  const doc = scan(text);
  checkConflicts(doc, name);
  const ranges = serverRanges(doc, name);
  if (ranges.length === 0) return null;
  const main = ranges.find(([start]) => isMainTable(doc.info[start].header.path, name));
  if (!main) {
    throw new TOMLConflictError(`config.toml defines only subtables of [mcp_servers.${name}]; add the table itself and try again`);
  }
  const rows = doc.rows.map((r) => ({ ...r }));
  const replaceValue = (l, rendered, what) => {
    const v = editableValue(doc, l, what);
    rows[l].text = `${v.prefix} ${rendered}${v.suffix}`;
  };
  const inserts = []; // [after line, text], applied last so line numbers hold

  // The main table's own lines: url, and the header if written there.
  let urlLine = -1;
  let headersLine = -1;
  const dotted = [];
  for (let l = main[0] + 1; l < main[1]; l++) {
    const key = doc.info[l].key;
    if (!key) continue;
    if (key.path.length === 1 && key.path[0] === 'url') urlLine = l;
    if (key.path.length === 1 && key.path[0] === 'http_headers') headersLine = l;
    if (key.path.length === 2 && key.path[0] === 'http_headers' && isAuthorization(key.path[1])) dotted.push(l);
  }
  // A [mcp_servers.<name>.http_headers] subtable, if the headers live there.
  const headersTable = ranges.find(([start]) => {
    const p = doc.info[start].header.path;
    return p.length === 3 && p[2] === 'http_headers';
  });
  const subAuth = [];
  if (headersTable) {
    for (let l = headersTable[0] + 1; l < headersTable[1]; l++) {
      const key = doc.info[l].key;
      if (key && key.path.length === 1 && isAuthorization(key.path[0])) subAuth.push(l);
    }
  }

  // After the header and any comment lines right below it (our note).
  let top = main[0];
  while (top + 1 < main[1] && isComment(rows[top + 1].text) && !doc.info[top + 1].continued) top++;

  if (urlLine >= 0) {
    if (editableValue(doc, urlLine, 'url').value !== url) replaceValue(urlLine, tomlString(url), 'url');
  } else {
    inserts.push([top, `url = ${tomlString(url)}`]);
  }

  let placed = false;
  if (headersLine >= 0) {
    const v = editableValue(doc, headersLine, 'http_headers');
    if (!v.table) throw new TOMLConflictError('config.toml sets http_headers to something other than a table; remove that line and try again');
    const pairs = v.value.map(([k, val]) => [k, isAuthorization(k) ? authorization : val]);
    if (!pairs.some(([k]) => isAuthorization(k))) pairs.push(['Authorization', authorization]);
    if (JSON.stringify(pairs) !== JSON.stringify(v.value)) rows[headersLine].text = `${v.prefix} ${inlineTable(pairs)}${v.suffix}`;
    placed = true;
  }
  for (const l of dotted.concat(subAuth)) {
    if (editableValue(doc, l, 'the Authorization header').value !== authorization) {
      replaceValue(l, tomlString(authorization), 'the Authorization header');
    }
    placed = true;
  }
  if (!placed) {
    if (headersTable) inserts.push([headersTable[0], `Authorization = ${tomlString(authorization)}`]);
    else inserts.push([urlLine >= 0 ? urlLine : top, `http_headers = ${inlineTable([['Authorization', authorization]])}`]);
  }

  // Insert from the bottom up; two inserts after the same line keep their
  // order (url before http_headers).
  inserts
    .map(([after, line], order) => ({ after, line, order }))
    .sort((a, b) => b.after - a.after || b.order - a.order)
    .forEach(({ after, line }) => rows.splice(after + 1, 0, newRow(doc, line)));

  const out = render(doc, rows);
  const back = readServer(out, name);
  const headers = back && back.http_headers && typeof back.http_headers === 'object' ? back.http_headers : {};
  const auth = Object.keys(headers).filter(isAuthorization);
  if (!back || back.url !== url || auth.length === 0 || auth.some((k) => headers[k] !== authorization)) {
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

module.exports = { setServer, updateServer, removeServer, readServer, TOMLConflictError, tomlString };
