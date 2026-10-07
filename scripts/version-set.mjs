/* eslint-disable security/detect-non-literal-fs-filename -- 中文注释：仅写入固定文件和经严格版本格式校验的草稿路径。 */
import {readFile, writeFile, unlink} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {JSON_VERSION_FILES, TEXT_VERSION_FILES, MIGRATION_VERSIONS, VERSION_PATTERN, documentVersionMatches, verifyReleaseVersions} from './package-version.mjs';

export async function setVersion(source, next) {
 if (typeof next !== 'string' || !VERSION_PATTERN.test(next)) throw Error('version:set expects x.y.z without leading zeros');
 const current = await verifyReleaseVersions(source);
 // 中文注释：逐段比较整数，不按字符串排序，也不依赖 Number 的精度上限。
 const before = current.split('.').map(BigInt), after = next.split('.').map(BigInt);
 const different = after.findIndex((value, index) => value !== before.at(index));
 if (different < 0 || after.at(different) < before.at(different)) throw Error(`New version ${next} must be greater than current version ${current}`);
 const releaseFile = `docs/release-${next}.md`;
 try {
  await readFile(path.join(source, releaseFile));
  throw Error(`${releaseFile} already exists; refusing to overwrite release history`);
 } catch (error) { if (error.code !== 'ENOENT') throw error; }
 const changes = [];
 const add = async (file, update) => {
  const original = await readFile(path.join(source, file), 'utf8');
  const content = update(original);
  if (content === original) throw Error(`${file}: no version update produced`);
  changes.push({file, original, content});
 };
 for (const file of JSON_VERSION_FILES) await add(file, text => {
  const data = JSON.parse(text);
  data.version = next;
  if (file.endsWith('package-lock.json')) data.packages[''].version = next;
  return `${JSON.stringify(data, null, 2)}\n`;
 });
 for (const file of TEXT_VERSION_FILES) await add(file, text => {
  if (file === 'scripts/migrate-to-browser-link.py') return text.replace(MIGRATION_VERSIONS, (match, versions) => match.replace(`{${versions}}`, `{${versions}, '${next}'}`));
  if (file === 'executor-plugin/plugin.yaml') return text.replace(/^version:\s*\S+/m, `version: ${next}`);
  // 中文注释：按已校验的位置从后往前替换，保留外部依赖版本和其余正文。
  for (const match of documentVersionMatches(text).reverse()) text = text.slice(0, match.index) + next + text.slice(match.index + match[0].length);
  return text;
 });
 const date = new Date().toLocaleDateString('en-CA', {timeZone: 'Asia/Shanghai'});
 await add('CHANGELOG.md', text => text.replace(/^## /m, `## ${next} — ${date}\n\n## `));
 const template = await readFile(path.join(source, 'docs/release-template.md'), 'utf8');
 if (!template.includes('{{version}}') || !template.includes('{{date}}')) throw Error('docs/release-template.md: missing version/date placeholders');
 const draft = template.replaceAll('{{version}}', next).replaceAll('{{date}}', date);
 changes.push({file: releaseFile, original: null, content: draft});
 // 中文注释：全部读取和校验成功后才落盘；写入或最终核验失败时恢复本次修改。
 const written = [];
 try {
  for (const change of changes) {
   if (change.original !== null) written.push(change);
   await writeFile(path.join(source, change.file), change.content, {flag: change.original === null ? 'wx' : 'w'});
   if (change.original === null) written.push(change);
  }
  await verifyReleaseVersions(source);
 } catch (error) {
  const rollbackErrors = [];
  for (const change of written.reverse()) {
   try {
    if (change.original === null) await unlink(path.join(source, change.file));
    else await writeFile(path.join(source, change.file), change.original);
   } catch (rollbackError) { rollbackErrors.push(rollbackError); }
  }
  if (rollbackErrors.length) throw new AggregateError([error, ...rollbackErrors], 'Version update failed; rollback incomplete, inspect the working tree');
  throw error;
 }
 return changes.map(change => change.file);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
 try {
  if (process.argv.length !== 3) throw Error('Usage: npm run version:set <x.y.z>');
  const files = await setVersion(path.resolve(import.meta.dirname, '..'), process.argv[2]);
  console.log(`Version set to ${process.argv[2]}. Changed files:\n${files.map(file => `- ${file}`).join('\n')}`);
 } catch (error) {
  console.error(error.message);
  process.exitCode = 1;
 }
}
