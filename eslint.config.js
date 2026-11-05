// @ts-check
import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import prettier from 'eslint-config-prettier';
import vue from 'eslint-plugin-vue';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const NODE_BUILTINS = [
  'assert',
  'buffer',
  'child_process',
  'cluster',
  'crypto',
  'dgram',
  'dns',
  'events',
  'fs',
  'fs/promises',
  'http',
  'http2',
  'https',
  'module',
  'net',
  'os',
  'path',
  'perf_hooks',
  'process',
  'readline',
  'stream',
  'tls',
  'url',
  'util',
  'v8',
  'vm',
  'worker_threads',
  'zlib',
];

/** Node.js built-ins, in both `fs` and `node:fs` forms. */
const nodeBuiltinPaths = NODE_BUILTINS.map((name) => ({
  name,
  message: 'Node.js APIs are not allowed here.',
}));
const nodePrefixPattern = {
  group: ['node:*'],
  message: 'Node.js APIs are not allowed here.',
};

/**
 * @param {string} message
 * @param {string[]} packages
 */
const banPackages = (message, packages) => ({ group: packages, message });

export default defineConfig(
  {
    ignores: [
      '**/node_modules/**',
      '**/out/**',
      '**/dist/**',
      '**/release/**',
      '**/coverage/**',
      '**/*.d.ts.map',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.strict,
  ...tseslint.configs.stylistic,
  ...vue.configs['flat/recommended'],

  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      eqeqeq: ['error', 'always'],
      'no-console': ['warn', { allow: ['warn', 'error', 'info'] }],
    },
  },

  // Vue single-file components: parse <script lang="ts"> with the TS parser.
  {
    files: ['**/*.vue'],
    languageOptions: {
      parserOptions: { parser: tseslint.parser, extraFileExtensions: ['.vue'] },
      globals: globals.browser,
    },
  },

  // Build/maintenance scripts (Node, may log to the console).
  {
    files: ['**/scripts/**/*.{js,mjs}'],
    languageOptions: { globals: globals.node },
    rules: { 'no-console': 'off' },
  },

  // Node-side code: config files, main process, preload, runtime packages.
  {
    files: [
      '*.{js,ts}',
      'apps/desktop/*.{js,ts}',
      'apps/desktop/src/main/**/*.ts',
      'apps/desktop/src/preload/**/*.ts',
      'packages/*/*.{js,ts}',
      'packages/*/src/**/*.ts',
    ],
    languageOptions: { globals: globals.node },
  },

  // ---------------------------------------------------------------------------
  // Architecture boundaries
  // ---------------------------------------------------------------------------

  // Renderer: browser code only. No Node, no Electron, no runtime packages.
  {
    files: ['apps/desktop/src/renderer/**/*.{ts,vue}'],
    languageOptions: { globals: globals.browser },
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            ...nodeBuiltinPaths,
            { name: 'electron', message: 'The renderer must use window.api (preload bridge).' },
          ],
          patterns: [
            nodePrefixPattern,
            banPackages('The renderer may only import @rka/shared.', [
              '@rka/agent-runtime',
              '@rka/model-provider',
              '@rka/tools',
              '@rka/storage',
            ]),
            banPackages('Do not import across Electron process folders.', [
              '**/main/**',
              '**/preload/**',
            ]),
          ],
        },
      ],
    },
  },

  // Preload: a thin, typed bridge. Only electron + @rka/shared.
  {
    files: ['apps/desktop/src/preload/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: nodeBuiltinPaths,
          patterns: [
            nodePrefixPattern,
            banPackages('Preload may only import electron and @rka/shared.', [
              '@rka/agent-runtime',
              '@rka/model-provider',
              '@rka/tools',
              '@rka/storage',
            ]),
            banPackages('Do not import across Electron process folders.', [
              '**/main/**',
              '**/renderer/**',
            ]),
          ],
        },
      ],
    },
  },

  // Main process must not reach into preload or renderer code.
  {
    files: ['apps/desktop/src/main/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            banPackages('Do not import across Electron process folders.', [
              '**/preload/**',
              '**/renderer/**',
            ]),
          ],
        },
      ],
    },
  },

  // All workspace packages are Electron-agnostic and import each other only
  // through package entry points (never deep paths).
  {
    files: ['packages/*/src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [{ name: 'electron', message: 'Packages must stay Electron-agnostic.' }],
          patterns: [
            banPackages('Import workspace packages through their entry point only.', ['@rka/*/*']),
          ],
        },
      ],
    },
  },

  // @rka/shared: pure, platform-neutral contracts. No Node, no other packages.
  {
    files: ['packages/shared/src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            ...nodeBuiltinPaths,
            { name: 'electron', message: 'Packages must stay Electron-agnostic.' },
          ],
          patterns: [
            nodePrefixPattern,
            banPackages('@rka/shared must not depend on other workspace packages.', ['@rka/*']),
          ],
        },
      ],
    },
  },

  // Leaf packages may depend only on @rka/shared.
  {
    files: [
      'packages/model-provider/src/**/*.ts',
      'packages/tools/src/**/*.ts',
      'packages/storage/src/**/*.ts',
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [{ name: 'electron', message: 'Packages must stay Electron-agnostic.' }],
          patterns: [
            banPackages('Leaf packages may depend only on @rka/shared.', [
              '@rka/agent-runtime',
              '@rka/model-provider',
              '@rka/tools',
              '@rka/storage',
            ]),
            banPackages('Import workspace packages through their entry point only.', ['@rka/*/*']),
          ],
        },
      ],
    },
  },

  // Must stay last: turns off stylistic rules that conflict with Prettier.
  prettier,
);
