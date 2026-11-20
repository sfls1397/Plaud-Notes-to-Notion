import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const [modules, ...files] = process.argv.slice(2);
const ts = createRequire(path.join(modules, 'reader.js'))('typescript');

function tokens(node, sourceFile, visit) {
  if (node.kind >= ts.SyntaxKind.FirstJSDocNode && node.kind <= ts.SyntaxKind.LastJSDocNode) return;
  const children = node.getChildren(sourceFile);
  if (children.length === 0) {
    visit(node);
    return;
  }
  for (const child of children) tokens(child, sourceFile, visit);
}

function specifiers(node, found) {
  const literal = (expression) => expression && ts.isStringLiteralLike(expression) ? expression.text : null;
  let text = null;
  if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) text = literal(node.moduleSpecifier);
  else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) text = literal(node.moduleReference.expression);
  else if (ts.isCallExpression(node) && node.arguments.length > 0 && (node.expression.kind === ts.SyntaxKind.ImportKeyword
    || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) text = literal(node.arguments[0]);
  else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) text = literal(node.argument.literal);
  if (text !== null) found.push({ specifier: text, node });
  ts.forEachChild(node, (child) => specifiers(child, found));
}

function kindOf(file) {
  if (file.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (/\.[cm]?ts$/.test(file)) return ts.ScriptKind.TS;
  return ts.ScriptKind.JS;
}

const comments = [];
const imports = [];
const unread = [];
for (const file of files) {
  const text = fs.readFileSync(file, 'utf8');
  const sourceFile = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kindOf(file));
  if (sourceFile.parseDiagnostics.length > 0) {
    unread.push(file);
    continue;
  }
  const seen = new Set();
  const markup = [];
  const local = [];
  const add = (range) => {
    if (seen.has(range.pos)) return;
    seen.add(range.pos);
    const start = sourceFile.getLineAndCharacterOfPosition(range.pos);
    const end = sourceFile.getLineAndCharacterOfPosition(range.end);
    local.push({ offset: range.pos, file, value: text.slice(range.pos, range.end), line: start.line + 1, column: start.character, endLine: end.line + 1, endColumn: end.character });
  };
  tokens(sourceFile, sourceFile, (token) => {
    if (token.kind === ts.SyntaxKind.JsxText) {
      markup.push([token.pos, token.end]);
      return;
    }
    for (const range of ts.getLeadingCommentRanges(text, token.pos) ?? []) add(range);
    for (const range of ts.getTrailingCommentRanges(text, token.end) ?? []) add(range);
  });
  for (const { offset, ...comment } of local) {
    if (!markup.some(([from, to]) => offset >= from && offset < to)) comments.push(comment);
  }
  const found = [];
  specifiers(sourceFile, found);
  for (const { specifier, node } of found) {
    imports.push({ file, specifier, line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1 });
  }
}
process.stdout.write(JSON.stringify({ comments, imports, unread }));
