/* eslint-disable security/detect-non-literal-fs-filename -- 中文注释：路径仅来自仓库内固定的版本文件清单。 */
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

export const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
export const JSON_VERSION_FILES = [
 'package.json', 'package-lock.json', 'executor-plugin/dashboard/manifest.json',
 'native-extension/manifest.json', 'cloud-link/site/package.json', 'cloud-link/site/package-lock.json',
];
export const TEXT_VERSION_FILES = [
 'executor-plugin/plugin.yaml',
 'README.md', 'README.zh-CN.md', 'docs/releasing.md', 'scripts/migrate-to-browser-link.py',
];
export const MIGRATION_VERSIONS = /extension\['version'\] not in \{([^}]+)\}/;

// 中文注释：README 的 Hermes/Node 前置版本属于外部依赖，不随本项目发布更新。
export function documentVersionMatches(text) {
 const releaseText = text.replace(/^\| (?:Hermes Agent|Node.js) \|.*$/gm, line => ' '.repeat(line.length));
 return [...releaseText.matchAll(/(?<!\d)\d+\.\d+\.\d+(?!\d)/g)];
}

const lineAt = (text, offset = 0) => text.slice(0, Math.max(0, offset)).split('\n').length;
const mismatch = (file, text, offset, detail) => {
 throw Error(`Package versions must match: ${file}:${lineAt(text, offset)}: ${detail}`);
};
async function sourceText(source, file) {
 try { return await readFile(path.join(source, file), 'utf8'); }
 catch (error) { throw Error(`Package versions must match: ${file}:1: ${error.code}`, {cause: error}); }
}
function expectVersion(file, text, offset, actual, expected, label) {
 if (actual !== expected) mismatch(file, text, offset, `${label}: expected ${expected}, found ${actual ?? 'missing'}`);
}

// 中文注释：构建、打包共用运行时版本闭包；发布文档由下方完整门禁检查。
export async function verifyPackageVersions(source) {
 let version;
 for (const file of JSON_VERSION_FILES) {
  const text = await sourceText(source, file);
  let data;
  try { data = JSON.parse(text); }
  catch (error) { mismatch(file, text, 0, `invalid JSON: ${error.message}`); }
  // 中文注释：标准文件按缩进定位字段；单行合成夹具的字段均在第一行。
  const top = /^ {2}"version"\s*:/m.exec(text) || /"version"\s*:/.exec(text);
  if (file === 'package.json') {
   version = data.version;
   if (typeof version !== 'string' || !VERSION_PATTERN.test(version)) mismatch(file, text, top?.index, 'version must be x.y.z without leading zeros');
  }
  expectVersion(file, text, top?.index, data.version, version, 'version');
  if (file.endsWith('package-lock.json')) {
   const nested = /^ {6}"version"\s*:/m.exec(text) || top;
   expectVersion(file, text, nested?.index, data.packages?.['']?.version, version, 'packages[""].version');
  }
 }
 const pluginFile = 'executor-plugin/plugin.yaml', plugin = await sourceText(source, pluginFile);
 const pluginVersion = /^version:\s*(\S+)/m.exec(plugin);
 expectVersion(pluginFile, plugin, pluginVersion?.index, pluginVersion?.[1], version, 'version');
 const backgroundFile = 'native-extension/background.mjs', background = await sourceText(source, backgroundFile);
 const handshakes = [...background.matchAll(/\bversion:\s*chrome\.runtime\.getManifest\(\)\.version\b/g)];
 if (handshakes.length !== 2 || /\bversion:\s*['"]/.test(background)) mismatch(backgroundFile, background, /\bversion:/.exec(background)?.index, 'handshake/status versions must both read chrome.runtime.getManifest().version');
 return version;
}

// 中文注释：只检查当前说明的版本副本，历史发布说明和 CHANGELOG 旧节不参与同步。
export async function verifyReleaseVersions(source) {
 const version = await verifyPackageVersions(source);
 for (const file of ['README.md', 'README.zh-CN.md', 'docs/releasing.md']) {
  const text = await sourceText(source, file);
  const matches = documentVersionMatches(text);
  if (!matches.length) mismatch(file, text, 0, 'current release version is missing');
  for (const match of matches) expectVersion(file, text, match.index, match[0], version, 'document version');
  const required = file.startsWith('README') ? [
   `**${version} —`,
   `https://github.com/fanjing188/hermes-browser-link/releases/download/v${version}/hermes-browser-link-${version}.zip`,
   `-o hermes-browser-link-${version}.zip`, `unzip hermes-browser-link-${version}.zip`, `cd hermes-browser-link-${version}`,
  ] : [
   `artifacts/public-source-${version}`, `--release ${version} --output out/browser-link-${version}`, `tag \`v${version}\``,
  ];
  for (const token of required) if (!text.includes(token)) mismatch(file, text, 0, `missing current release reference: ${token}`);
 }
 const changelogFile = 'CHANGELOG.md', changelog = await sourceText(source, changelogFile);
 const firstSection = /^##\s+(.+)$/m.exec(changelog);
 const topVersion = /^(\d+\.\d+\.\d+) — \d{4}-\d{2}-\d{2}/.exec(firstSection?.[1] || '');
 expectVersion(changelogFile, changelog, firstSection?.index, topVersion?.[1], version, 'top release section');
 const releaseFile = `docs/release-${version}.md`, release = await sourceText(source, releaseFile);
 const title = /^# Hermes Browser Link (\S+)$/m.exec(release);
 expectVersion(releaseFile, release, title?.index, title?.[1], version, 'release title');
 const migrationFile = 'scripts/migrate-to-browser-link.py', migration = await sourceText(source, migrationFile);
 const supported = MIGRATION_VERSIONS.exec(migration);
 if (!supported || !supported[1].split(',').some(value => value.trim() === `'${version}'`)) mismatch(migrationFile, migration, supported?.index, `known migration versions must include ${version}`);
 return version;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
 try {
  const version = await verifyReleaseVersions(path.resolve(import.meta.dirname, '..'));
  console.log(`Version check OK: ${version}`);
 } catch (error) {
  console.error(error.message);
  process.exitCode = 1;
 }
}
