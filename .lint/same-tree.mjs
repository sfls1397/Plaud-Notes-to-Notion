import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const [modules, command, ...files] = process.argv.slice(2);
const ts = createRequire(path.join(modules ?? '.', 'same-tree.js'))('typescript');
const TEST_CALLS = new Set(['it', 'test', 'describe']);
const TEST_MODES = new Set(['only', 'skip', 'todo']);
const KEYWORD_FLAGS = ts.NodeFlags.BlockScoped | ts.NodeFlags.Namespace;
const BOOLEAN_PROPERTIES = ['isTypeOnly', 'isExportEquals'];

function kindOf(file) {
  if (file.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (/\.[cm]?ts$/.test(file)) return ts.ScriptKind.TS;
  return ts.ScriptKind.JS;
}

function parse(file) {
  const text = fs.readFileSync(file, 'utf8');
  const sourceFile = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kindOf(file));
  if (sourceFile.parseDiagnostics.length > 0) throw new Error(`${file} does not parse as TypeScript`);
  return { text, sourceFile };
}

function tokens(node, sourceFile, visit) {
  if (node.kind >= ts.SyntaxKind.FirstJSDocNode && node.kind <= ts.SyntaxKind.LastJSDocNode) return;
  const children = node.getChildren(sourceFile);
  if (children.length === 0) {
    visit(node);
    return;
  }
  for (const child of children) tokens(child, sourceFile, visit);
}

function commentRanges(text, sourceFile) {
  const seen = new Map();
  const markup = [];
  tokens(sourceFile, sourceFile, (token) => {
    if (token.kind === ts.SyntaxKind.JsxText) {
      markup.push([token.pos, token.end]);
      return;
    }
    for (const range of ts.getLeadingCommentRanges(text, token.pos) ?? []) seen.set(range.pos, range);
    for (const range of ts.getTrailingCommentRanges(text, token.end) ?? []) seen.set(range.pos, range);
  });
  return [...seen.values()]
    .filter((range) => !markup.some(([from, to]) => range.pos >= from && range.pos < to))
    .sort((a, b) => a.pos - b.pos);
}

function strip(file) {
  const { text, sourceFile } = parse(file);
  let out = '';
  let at = 0;
  for (const range of commentRanges(text, sourceFile)) {
    out += text.slice(at, range.pos) + '\0';
    at = range.end;
  }
  out += text.slice(at);
  const lines = [];
  for (const line of out.split('\n')) {
    if (!line.includes('\0')) {
      lines.push(line);
      continue;
    }
    const cleaned = line.replaceAll('\0', '').trimEnd();
    if (cleaned !== '') lines.push(cleaned);
  }
  return lines.join('\n');
}

function isTestTitle(node) {
  const call = node.parent;
  if (!call || !ts.isCallExpression(call) || call.arguments[0] !== node) return false;
  if (!ts.isStringLiteralLike(node)) return false;
  const callee = call.expression;
  if (ts.isIdentifier(callee)) return TEST_CALLS.has(callee.text);
  return ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression)
    && TEST_CALLS.has(callee.expression.text) && TEST_MODES.has(callee.name.text);
}

function children(node) {
  const found = [];
  ts.forEachChild(node, (child) => {
    found.push(child);
  });
  return found;
}

function lineOf(node) {
  const sourceFile = node.getSourceFile();
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

function difference(a, b) {
  if (a.kind !== b.kind) return 'node kind';
  if ((a.flags & KEYWORD_FLAGS) !== (b.flags & KEYWORD_FLAGS)) return 'declaration kind';
  for (const property of BOOLEAN_PROPERTIES) {
    if (Boolean(a[property]) !== Boolean(b[property])) return property;
  }
  if (a.operator !== b.operator) return 'operator';
  if (!ts.isSourceFile(a) && (typeof a.text === 'string' || typeof b.text === 'string')) {
    const left = isTestTitle(a) ? '' : a.text;
    const right = isTestTitle(b) ? '' : b.text;
    if (left !== right) return 'name or literal value';
  }
  const left = children(a);
  const right = children(b);
  if (left.length !== right.length) return 'child count';
  for (let i = 0; i < left.length; i++) {
    const inner = difference(left[i], right[i]);
    if (inner) return inner + ' at ' + ts.SyntaxKind[left[i].kind] + ' line ' + lineOf(left[i]) + ' / line ' + lineOf(right[i]);
  }
  return null;
}

function compare(before, after) {
  const found = difference(parse(before).sourceFile, parse(after).sourceFile);
  if (found === null) return 'same tree\n';
  process.exitCode = 1;
  return 'different tree: ' + found + '\n';
}

if (command === 'strip' && files.length === 1) process.stdout.write(strip(files[0]));
else if (command === 'compare' && files.length === 2) process.stdout.write(compare(files[0], files[1]));
else {
  process.stderr.write('usage: node .lint/same-tree.mjs <node_modules> strip FILE | compare BEFORE AFTER\n');
  process.exitCode = 2;
}
