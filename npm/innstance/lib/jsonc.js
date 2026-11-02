'use strict';

// A small JSON-with-comments reader and surgical editor.
//
// The agent configs this package edits are shared files: ~/.claude.json holds
// every Claude Code setting and project history, and OpenCode and Cursor
// accept comments and trailing commas in theirs. Parsing such a file and
// writing JSON.stringify(...) back would reformat the whole thing, drop every
// comment, and reorder nothing but still touch every line. Instead the file is
// parsed into a tree that remembers where each value starts and ends, and an
// edit replaces, inserts or removes exactly one member's text. Everything else
// in the file — comments, spacing, key order, number spellings — stays
// byte-for-byte as it was.

class JSONCError extends Error {
  constructor(message, offset, text) {
    const { line, column } = lineColumn(text, offset);
    super(`${message} at line ${line}, column ${column}`);
    this.name = 'JSONCError';
  }
}

const NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;

function lineColumn(text, offset) {
  let line = 1;
  let last = -1;
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text[i] === '\n') {
      line++;
      last = i;
    }
  }
  return { line, column: offset - last };
}

// parseTree returns the root node. Nodes carry [start, end) offsets into text.
//   object: { type, start, end, members: [{ key, keyStart, value, comma }] }
//   array:  { type, start, end, items: [node] }
//   scalar: { type: 'string' | 'number' | 'literal', start, end, value }
// comma is the offset of the comma that follows a member, or -1.
function parseTree(text) {
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;

  function skipTrivia() {
    for (;;) {
      const c = text[i];
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
        i++;
      } else if (c === '/' && text[i + 1] === '/') {
        while (i < text.length && text[i] !== '\n') i++;
      } else if (c === '/' && text[i + 1] === '*') {
        const close = text.indexOf('*/', i + 2);
        if (close < 0) throw new JSONCError('unterminated comment', i, text);
        i = close + 2;
      } else {
        return;
      }
    }
  }

  function parseString() {
    const start = i;
    i++; // opening quote
    for (;;) {
      if (i >= text.length) throw new JSONCError('unterminated string', start, text);
      const c = text[i];
      if (c === '"') {
        i++;
        break;
      }
      if (c === '\\') {
        i += 2;
        continue;
      }
      if (c === '\n' || c === '\r') throw new JSONCError('line break inside a string', i, text);
      i++;
    }
    let value;
    try {
      value = JSON.parse(text.slice(start, i));
    } catch {
      throw new JSONCError('invalid string', start, text);
    }
    return { type: 'string', start, end: i, value };
  }

  function parseValue() {
    skipTrivia();
    const c = text[i];
    if (c === '{') return parseObject();
    if (c === '[') return parseArray();
    if (c === '"') return parseString();
    const start = i;
    NUMBER.lastIndex = i;
    const number = NUMBER.exec(text);
    if (number) {
      i += number[0].length;
      return { type: 'number', start, end: i, value: Number(number[0]) };
    }
    for (const [word, value] of [['true', true], ['false', false], ['null', null]]) {
      if (text.startsWith(word, i)) {
        i += word.length;
        return { type: 'literal', start, end: i, value };
      }
    }
    throw new JSONCError(i >= text.length ? 'unexpected end of file' : `unexpected ${JSON.stringify(c)}`, i, text);
  }

  function parseObject() {
    const node = { type: 'object', start: i, end: -1, members: [] };
    i++;
    for (;;) {
      skipTrivia();
      if (text[i] === '}') {
        i++;
        node.end = i;
        return node;
      }
      if (text[i] !== '"') throw new JSONCError('expected a quoted key', i, text);
      const keyNode = parseString();
      skipTrivia();
      if (text[i] !== ':') throw new JSONCError('expected ":"', i, text);
      i++;
      const value = parseValue();
      const member = { key: keyNode.value, keyStart: keyNode.start, value, comma: -1 };
      node.members.push(member);
      skipTrivia();
      if (text[i] === ',') {
        member.comma = i;
        i++;
        continue;
      }
      if (text[i] === '}') continue;
      throw new JSONCError('expected "," or "}"', i, text);
    }
  }

  function parseArray() {
    const node = { type: 'array', start: i, end: -1, items: [] };
    i++;
    for (;;) {
      skipTrivia();
      if (text[i] === ']') {
        i++;
        node.end = i;
        return node;
      }
      node.items.push(parseValue());
      skipTrivia();
      if (text[i] === ',') {
        i++;
        continue;
      }
      if (text[i] === ']') continue;
      throw new JSONCError('expected "," or "]"', i, text);
    }
  }

  const root = parseValue();
  skipTrivia();
  if (i < text.length) throw new JSONCError('unexpected text after the value', i, text);
  return root;
}

function toValue(node) {
  switch (node.type) {
    case 'object': {
      const out = {};
      for (const m of node.members) {
        // Same rule as JSON.parse: a repeated key's last value wins. The key
        // is defined as an own property so "__proto__" stays plain data.
        Object.defineProperty(out, m.key, { value: toValue(m.value), enumerable: true, writable: true, configurable: true });
      }
      return out;
    }
    case 'array':
      return node.items.map(toValue);
    default:
      return node.value;
  }
}

// parse reads JSON or JSONC. Empty or whitespace-only text is undefined, which
// callers treat as "no settings yet".
function parse(text) {
  if (text.replace(/^﻿/, '').trim() === '') return undefined;
  return toValue(parseTree(text));
}

function findMember(objectNode, key) {
  // The last occurrence is the effective one, as with JSON.parse.
  for (let k = objectNode.members.length - 1; k >= 0; k--) {
    if (objectNode.members[k].key === key) return objectNode.members[k];
  }
  return null;
}

function lineStart(text, offset) {
  const nl = text.lastIndexOf('\n', offset - 1);
  return nl + 1;
}

function indentOfLine(text, offset) {
  const start = lineStart(text, offset);
  return /^[ \t]*/.exec(text.slice(start))[0];
}

function onOwnLine(text, offset) {
  return /^[ \t]*$/.test(text.slice(lineStart(text, offset), offset));
}

function detectStyle(text, root) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const compact = !text.includes('\n');
  let unit = '  ';
  if (root && root.type === 'object' && root.members.length > 0 && onOwnLine(text, root.members[0].keyStart)) {
    const found = indentOfLine(text, root.members[0].keyStart);
    if (found.length > 0) unit = found;
  }
  return { eol, compact, unit };
}

function serialize(value, baseIndent, style) {
  if (style.compact) return JSON.stringify(value);
  return JSON.stringify(value, null, style.unit).split('\n').join(style.eol + baseIndent);
}

function insertMember(text, objectNode, key, value, style) {
  const open = objectNode.start + 1;
  const close = objectNode.end - 1;
  if (style.compact) {
    const sep = objectNode.members.length > 0 ? ',' : '';
    return text.slice(0, open) + JSON.stringify(key) + ':' + JSON.stringify(value) + sep + text.slice(open);
  }
  let indent;
  if (objectNode.members.length > 0 && onOwnLine(text, objectNode.members[0].keyStart)) {
    indent = indentOfLine(text, objectNode.members[0].keyStart);
  } else {
    indent = indentOfLine(text, objectNode.start) + style.unit;
  }
  const member = JSON.stringify(key) + ': ' + serialize(value, indent, style);
  if (objectNode.members.length > 0) {
    // New member goes first: the text after "{" already starts the old first
    // member on its own line, so no existing comma has to move.
    return text.slice(0, open) + style.eol + indent + member + ',' + text.slice(open);
  }
  const inner = text.slice(open, close);
  const closingIndent = indentOfLine(text, objectNode.start);
  if (inner.trim() === '') {
    return text.slice(0, open) + style.eol + indent + member + style.eol + closingIndent + text.slice(close);
  }
  // Only comments inside: keep them, after the new member.
  return text.slice(0, open) + style.eol + indent + member + text.slice(open);
}

function replaceValue(text, member, value, style) {
  const indent = onOwnLine(text, member.keyStart) ? indentOfLine(text, member.keyStart) : '';
  return text.slice(0, member.value.start) + serialize(value, indent, style) + text.slice(member.value.end);
}

function removeMemberText(text, objectNode, member) {
  const index = objectNode.members.indexOf(member);
  const prev = index > 0 ? objectNode.members[index - 1] : null;
  let start = member.keyStart;
  let end = member.comma >= 0 ? member.comma + 1 : member.value.end;
  // When the removed member was last, the one before it now is, so its comma
  // goes too. That comma sits before `start`, so its offset stays valid.
  const dropPrevComma = (out) => (member.comma < 0 && prev && prev.comma >= 0 ? out.slice(0, prev.comma) + out.slice(prev.comma + 1) : out);
  if (onOwnLine(text, start)) {
    // Take the whole line when the member had it to itself.
    const rest = /^[ \t]*(\r?\n)?/.exec(text.slice(end));
    if (rest[1]) {
      start = lineStart(text, start);
      end += rest[0].length;
    }
    return dropPrevComma(text.slice(0, start) + text.slice(end));
  }
  // Sharing a line with its neighbours: take the separating space as well.
  if (member.comma >= 0) {
    end += /^[ \t]*/.exec(text.slice(end))[0].length;
    return text.slice(0, start) + text.slice(end);
  }
  if (prev && prev.comma >= 0 && text.slice(prev.comma + 1, start).trim() === '') {
    return text.slice(0, prev.comma) + text.slice(end);
  }
  return dropPrevComma(text.slice(0, start) + text.slice(end));
}

function rootObject(text) {
  const root = parseTree(text);
  if (root.type !== 'object') throw new Error('the file does not contain a JSON object');
  return root;
}

// setAt returns text with obj[path[0]][path[1]]... set to value, creating the
// intermediate objects it needs. Empty text becomes a new document; seed, if
// given, supplies top-level members for that new document only.
function setAt(text, path, value, { seed } = {}) {
  if (text === null || text.replace(/^﻿/, '').trim() === '') {
    const doc = { ...(seed || {}) };
    let cursor = doc;
    for (let k = 0; k < path.length - 1; k++) {
      cursor[path[k]] = {};
      cursor = cursor[path[k]];
    }
    cursor[path[path.length - 1]] = value;
    return JSON.stringify(doc, null, 2) + '\n';
  }
  let node = rootObject(text);
  const style = detectStyle(text, node);
  for (let k = 0; k < path.length; k++) {
    const member = findMember(node, path[k]);
    const last = k === path.length - 1;
    if (!member) {
      // Build the missing tail as one nested value and insert it here.
      let tail = value;
      for (let j = path.length - 1; j > k; j--) tail = { [path[j]]: tail };
      return verified(insertMember(text, node, path[k], tail, style), path, value);
    }
    if (last) {
      return verified(replaceValue(text, member, value, style), path, value);
    }
    if (member.value.type !== 'object') {
      throw new Error(`"${path.slice(0, k + 1).join('.')}" is not an object`);
    }
    node = member.value;
  }
  return text;
}

// removeAt removes every occurrence of the member at path. Returns the text
// unchanged when there is nothing to remove.
function removeAt(text, path) {
  if (text === null || text.replace(/^﻿/, '').trim() === '') return text;
  for (;;) {
    let node = rootObject(text);
    let member = null;
    for (let k = 0; k < path.length; k++) {
      member = findMember(node, path[k]);
      if (!member) return text;
      if (k < path.length - 1) {
        if (member.value.type !== 'object') return text;
        node = member.value;
      }
    }
    text = removeMemberText(text, node, member);
    // Re-parse after every removal: offsets of any duplicate have moved.
    // An object left with nothing but whitespace inside reads as "{}".
    let parent = rootObject(text);
    for (let k = 0; k < path.length - 1; k++) parent = findMember(parent, path[k]).value;
    if (parent.members.length === 0 && text.slice(parent.start + 1, parent.end - 1).trim() === '') {
      text = text.slice(0, parent.start + 1) + text.slice(parent.end - 1);
    }
  }
}

function getAt(value, path) {
  let cursor = value;
  for (const key of path) {
    if (!cursor || typeof cursor !== 'object' || Array.isArray(cursor) || !Object.prototype.hasOwnProperty.call(cursor, key)) {
      return undefined;
    }
    cursor = cursor[key];
  }
  return cursor;
}

// verified re-reads an edit before it is allowed anywhere near the disk. The
// editor is small and the files are someone else's; this turns any mistake in
// it into a refusal instead of a corrupted config.
function verified(text, path, value) {
  const reread = parse(text);
  if (JSON.stringify(getAt(reread, path)) !== JSON.stringify(value)) {
    throw new Error('internal error: the edited file did not read back as written');
  }
  return text;
}

module.exports = { parse, parseTree, setAt, removeAt, getAt, JSONCError };
