import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const modules = process.env.REPO_LINT_MODULES;
if (!modules) throw new Error('REPO_LINT_MODULES names the lint tools folder; run python3 .security/lint.py');
const tools = createRequire(`${modules}/tools.js`);
const loaded = await import(pathToFileURL(tools.resolve('typescript-eslint')).href);
const tseslint = loaded.default ?? loaded;

const rules = Object.fromEntries([
  'array-callback-return', 'constructor-super', 'for-direction', 'getter-return', 'no-async-promise-executor', 'no-caller',
  'no-case-declarations', 'no-class-assign', 'no-compare-neg-zero', 'no-cond-assign', 'no-const-assign', 'no-constant-binary-expression',
  'no-constant-condition', 'no-constructor-return', 'no-debugger', 'no-delete-var', 'no-dupe-args', 'no-dupe-class-members',
  'no-dupe-else-if', 'no-dupe-keys', 'no-duplicate-case', 'no-empty-character-class', 'no-empty-pattern', 'no-ex-assign',
  'no-extend-native', 'no-func-assign', 'no-global-assign', 'no-import-assign', 'no-invalid-regexp', 'no-iterator', 'no-label-var',
  'no-loss-of-precision', 'no-misleading-character-class', 'no-new-native-nonconstructor', 'no-new-wrappers',
  'no-nonoctal-decimal-escape', 'no-obj-calls', 'no-octal', 'no-octal-escape', 'no-proto', 'no-redeclare', 'no-script-url',
  'no-self-assign', 'no-self-compare', 'no-sequences', 'no-setter-return', 'no-shadow-restricted-names', 'no-this-before-super',
  'no-unassigned-vars', 'no-undef', 'no-unexpected-multiline', 'no-unreachable', 'no-unreachable-loop', 'no-unsafe-negation',
  'no-unsafe-optional-chaining', 'no-unused-labels', 'no-unused-private-class-members', 'no-useless-backreference', 'no-with',
  'use-isnan', 'valid-typeof',
].map((name) => [name, 'error']));
rules['no-unused-vars'] = ['error', { vars: 'all', args: 'none', caughtErrors: 'none', ignoreRestSiblings: true, varsIgnorePattern: '^_' }];

const runtime = Object.fromEntries(Object.getOwnPropertyNames(globalThis).map((name) => [name, 'readonly']));
const commonjs = { require: 'readonly', module: 'writable', exports: 'writable', __dirname: 'readonly', __filename: 'readonly' };
const typescript = ['**/*.ts', '**/*.mts', '**/*.cts', '**/*.tsx'];

export default [
  { linterOptions: { noInlineConfig: true, reportUnusedDisableDirectives: 'off', reportUnusedInlineConfigs: 'off' } },
  { files: ['**/*.js', '**/*.mjs'], languageOptions: { ecmaVersion: 'latest', sourceType: 'module', globals: runtime }, rules },
  { files: ['**/*.cjs'], languageOptions: { ecmaVersion: 'latest', sourceType: 'commonjs', globals: { ...runtime, ...commonjs } }, rules },
  { files: typescript, languageOptions: { parser: tseslint.parser, ecmaVersion: 'latest', sourceType: 'module', globals: runtime }, rules },
  ...tseslint.configs.recommended.map((config) => ({ ...config, files: typescript })),
  {
    files: typescript,
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/ban-ts-comment': 'off',
      '@typescript-eslint/no-unused-expressions': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { vars: 'all', args: 'none', caughtErrors: 'none', ignoreRestSiblings: true, varsIgnorePattern: '^_' }],
      'no-unused-vars': 'off',
    },
  },
];
