import js from '@eslint/js';
import security from 'eslint-plugin-security';

const readonly = names => Object.fromEntries(names.map(name => [name, 'readonly']));

// Web platform and extension APIs available to extension, page and module code.
const webGlobals = readonly([
  'chrome', 'document', 'window', 'globalThis', 'location', 'navigator', 'console', 'performance', 'crypto',
  'fetch', 'Headers', 'Request', 'Response', 'URL', 'URLSearchParams', 'WebSocket',
  'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'queueMicrotask', 'structuredClone',
  'requestAnimationFrame', 'cancelAnimationFrame', 'atob', 'btoa', 'TextEncoder', 'TextDecoder',
  'AbortController', 'AbortSignal', 'DOMException', 'DOMParser', 'MutationObserver', 'Event', 'CustomEvent',
  'Blob', 'File', 'FileList', 'FileReader', 'FormData', 'Node', 'createImageBitmap', 'OffscreenCanvas', 'MediaRecorder',
]);

// Extra DOM names used by code that runs inside pages.
const pageGlobals = readonly([
  'DataTransfer', 'DragEvent', 'getComputedStyle', 'innerWidth', 'innerHeight', 'devicePixelRatio',
  'scrollX', 'scrollY', 'visualViewport', 'scrollTo', 'HTMLInputElement', 'HTMLTextAreaElement',
]);

const nodeGlobals = readonly([
  'process', 'Buffer', '__dirname', '__filename', 'require', 'module', 'exports', 'global', 'setImmediate',
]);

export default [
  js.configs.recommended,

  {
    languageOptions: { ecmaVersion: 2022, sourceType: 'module', globals: webGlobals },
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
      'no-console': 'off',
      'no-var': 'error',
      'prefer-const': 'warn',
      'prefer-template': 'warn',
      'no-throw-literal': 'warn',
      'prefer-object-spread': 'warn',
      // Empty catch blocks intentionally ignore best-effort cleanup and optional probes.
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },

  // Node entry points: tooling, tests and real-browser runners.
  {
    files: [
      'scripts/**', 'tests/**', 'executor-plugin/desktop/**',
      'cloud-link/site/scripts/**', 'cloud-link/site/tests/**',
      'browser-interactions/test/**', 'browser-workspaces/**', 'page-semantics/**', 'native-extension/build.mjs',
    ],
    languageOptions: { globals: nodeGlobals },
  },

  // 中文注释：云端 Worker 使用 Node 22 支持的 JSON import attributes，只放宽该目录的解析版本。
  { files: ['cloud-link/site/worker/**'], languageOptions: { ecmaVersion: 2025 } },

  // Code evaluated inside web pages.
  {
    files: ['browser-interactions/index.mjs', 'browser-interactions/test/**', 'native-extension/core.mjs'],
    languageOptions: { globals: pageGlobals },
  },

  // The interaction fixture exposes these element IDs as named window properties.
  {
    files: ['browser-interactions/test/acceptance.mjs', 'browser-interactions/test/interactions.test.mjs'],
    languageOptions: { globals: readonly(['results', 'source', 'cover', 'target']) },
  },

  {
    files: ['scripts/**', 'tests/**'],
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', caughtErrors: 'none', varsIgnorePattern: '^(assert|test)$' }],
    },
  },

  // Security rules. The extension must never execute dynamically constructed code.
  {
    files: ['native-extension/**/*.mjs', 'scripts/**/*.mjs', 'tests/**/*.mjs'],
    ...security.configs.recommended,
    rules: {
      ...security.configs.recommended.rules,
      'security/detect-eval-with-expression': 'error',
      'no-new-func': 'error',
    },
  },

  {
    ignores: [
      'node_modules/',
      '.ci/',
      // 中文注释：.claude/ 是本机代理工具目录（含会话 worktree），已在 .gitignore 中，不属于源码。
      '.claude/',
      '**/node_modules/',
      'artifacts/',
      'release/',
      // 中文注释：所有子项目的构建输出均不属于源码 lint，包括云端 Worker 打包结果。
      '**/dist/',
      'out/',
      'tmp/',
      '.tmp/',
      'native-extension/dist-native/',
    ],
  },
];
