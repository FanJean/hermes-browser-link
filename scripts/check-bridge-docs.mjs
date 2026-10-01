#!/usr/bin/env node
// Checks project documentation for broken local links, personal absolute paths and credentials.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve, join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT_DOCS = ['README.md', 'README.zh-CN.md', 'CONTRIBUTING.md', 'SECURITY.md', 'CHANGELOG.md', 'CODE_OF_CONDUCT.md'];
const args = process.argv.slice(2);
if (args.length !== 0 && (args.length !== 2 || args[0] !== '--root')) {
  console.error('Usage: node scripts/check-bridge-docs.mjs [--root DIR]');
  process.exit(2);
}
const root = args.length ? resolve(args[1]) : resolve(fileURLToPath(new URL('..', import.meta.url)));
const docsDir = join(root, 'docs');
const files = [
  ...ROOT_DOCS.map(name => join(root, name)).filter(existsSync),
  ...(existsSync(docsDir) ? readdirSync(docsDir).filter(name => name.endsWith('.md')).sort().map(name => join(docsDir, name)) : []),
];
const errors = [];
if (!files.some(file => relative(root, file) === 'README.md')) errors.push('README.md: missing');
for (const path of files) {
  const label = relative(root, path);
  const text = readFileSync(path, 'utf8');
  let fenced = false;
  for (const [index, line] of text.split('\n').entries()) {
    const where = `${label}:${index + 1}`;
    if (/(?:\/(?:Users|home|private\/var\/folders)\/[^\s`)]|[A-Za-z]:\\\\Users\\\\[^\s`)]|~\/\.hermes\/)/.test(line))
      errors.push(`${where}: personal absolute path`);
    if (/\b(?:API_SERVER_KEY|HERMES_API_TOKEN|(?:access|secret|api)[_-]?key|password|bearer[_-]?token)\s*[:=]\s*['"]?[A-Za-z0-9_-]{12,}/i.test(line))
      errors.push(`${where}: possible credential`);
    if (/^\s*```/.test(line)) { fenced = !fenced; continue; }
    if (fenced) continue;
    for (const match of line.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
      const target = match[1].split('#')[0];
      if (!target || /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(target)) continue;
      const destination = resolve(dirname(path), decodeURIComponent(target));
      if (!destination.startsWith(root + '/') || !existsSync(destination))
        errors.push(`${where}: broken local link: ${match[1]}`);
    }
  }
}
if (errors.length) {
  for (const error of errors) console.error(error);
  process.exitCode = 1;
} else console.log(`Docs OK (${files.length} files)`);
