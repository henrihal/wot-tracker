import { defineConfig } from 'eslint/config'
import eslintConfigPrettier from 'eslint-config-prettier'

export default [
    defineConfig([
        {
            rules: {
                semi: "error",
                "prefer-const": "error",
            },
        }
    ]),
    eslintConfigPrettier]
