module.exports = {
  root: true,
  env: {
    browser: true,
    node: true,
    es2022: true,
  },
  extends: ['eslint:recommended'],
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
  },
  rules: {
    'no-console': 'off',
  },
  overrides: [
    {
      files: ['public/app.js'],
      rules: {
        'no-unused-vars': 'off',
        'no-empty': 'off',
      },
    },
  ],
};
