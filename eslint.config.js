'use strict';

// Config minima para um back-end Node/CommonJS simples — sem framework de
// estilo (Airbnb/Standard) nem plugins extras, so as regras recomendadas do
// ESLint aplicadas ao ambiente Node (globals: require, module, process, etc.).
const js = require('@eslint/js');

module.exports = [
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: {
        require: 'readonly',
        module: 'readonly',
        exports: 'writable',
        process: 'readonly',
        console: 'readonly',
        __dirname: 'readonly',
        Buffer: 'readonly',
        setTimeout: 'readonly',
        setInterval: 'readonly',
        clearTimeout: 'readonly',
        clearInterval: 'readonly',
        // Disponiveis globalmente desde o Node 18+ (engines exige >=20 — ver package.json).
        fetch: 'readonly',
        AbortSignal: 'readonly',
      },
    },
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }],
    },
  },
  {
    // loadtest/pedidos.js roda no runtime proprio do k6 (import/export ESM,
    // modulos k6/* que nao existem no Node) — fora do escopo deste lint.
    ignores: [
      'node_modules/**',
      'psp-fake/node_modules/**',
      'test-results/**',
      'loadtest/**',
    ],
  },
];
