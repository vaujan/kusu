import { defineConfig } from 'eslint/config'
import tseslint from '@electron-toolkit/eslint-config-ts'
import eslintConfigPrettier from '@electron-toolkit/eslint-config-prettier'
import eslintPluginReact from 'eslint-plugin-react'
import eslintPluginReactHooks from 'eslint-plugin-react-hooks'
import eslintPluginReactRefresh from 'eslint-plugin-react-refresh'

export default defineConfig(
  {
    ignores: [
      '**/node_modules',
      '**/dist',
      '**/out',
      '**/build',
      'storybook-static/**',
      '.agents/**',
      '.performance/**',
      'tmp/**'
    ]
  },
  { ignores: ['src/renderer/src/features/items/live/atomic/**'] },
  tseslint.configs.recommended,
  eslintPluginReact.configs.flat.recommended,
  eslintPluginReact.configs.flat['jsx-runtime'],
  {
    settings: {
      react: {
        version: 'detect'
      }
    }
  },
  {
    files: ['**/*.{ts,tsx}'],
    plugins: {
      'react-hooks': eslintPluginReactHooks,
      'react-refresh': eslintPluginReactRefresh
    },
    rules: {
      ...eslintPluginReactHooks.configs.recommended.rules,
      ...eslintPluginReactRefresh.configs.vite.rules
    }
  },
  {
    files: [
      'src/renderer/src/components/ui/**/*.tsx',
      'src/renderer/src/features/shell/app-sidebar.tsx',
      'src/renderer/src/features/shell/app-toaster.tsx',
      'src/renderer/src/settings/settings-context.tsx'
    ],
    rules: {
      '@typescript-eslint/explicit-function-return-type': 'off',
      'react-refresh/only-export-components': 'off'
    }
  },
  {
    files: ['tests/**/*.cjs'],
    rules: {
      '@typescript-eslint/no-require-imports': 'off'
    }
  },
  {
    files: ['.storybook/preview.tsx'],
    rules: {
      'react-refresh/only-export-components': 'off'
    }
  },
  eslintConfigPrettier
)
