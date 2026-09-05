import js from '@eslint/js';
import globals from 'globals';

// Formatting is Prettier's job; this is only what a formatter cannot see:
// unused variables, undeclared globals, a forgotten await's dead promise.
export default [
  { ignores: ['coverage/', 'node_modules/', 'public/app.css', 'docs/docs.css'] },
  js.configs.recommended,
  {
    files: ['**/*.js'],
    languageOptions: {
      // node 24, which implements ES2025 in full; see jsconfig.json's target.
      ecmaVersion: 2025,
      sourceType: 'module',
      globals: globals.node,
    },
    rules: {
      // The house style ignores unwanted args and error bindings on purpose
      // (`catch { … }`, handlers that only need the second parameter).
      'no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', caughtErrors: 'none', ignoreRestSiblings: true },
      ],
      // The sanitizers (uploads, workspace names) strip control characters on
      // purpose: a regex naming \x00 is the point, not an accident.
      'no-control-regex': 'off',
    },
  },
  {
    // The frontend and the documentation site: plain scripts in a browser, not
    // modules in node.
    files: ['public/**/*.js', 'docs/**/*.js'],
    languageOptions: {
      sourceType: 'script',
      globals: globals.browser,
    },
  },
  {
    // The one frontend file that is a module: it imports three.js, which only
    // ships as one, and developer.js imports it in turn.
    files: ['public/island3d.js'],
    languageOptions: {
      sourceType: 'module',
      globals: globals.browser,
    },
  },
];
