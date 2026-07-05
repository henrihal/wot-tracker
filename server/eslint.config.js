import eslintConfigPrettier from 'eslint-config-prettier'

export default [
  {
    ignores: ['dist/**'],
  },
  {
    rules: {
      'prefer-const': 'error',
    },
  },
  eslintConfigPrettier,
]
