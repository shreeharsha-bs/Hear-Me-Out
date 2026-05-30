import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, __dirname, '')
  const apiUrl = env.VITE_API_URL || 'http://localhost:5001'
  const personaplexUrl = env.VITE_PERSONAPLEX_URL || 'http://localhost:8000'

  return {
    plugins: [react()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src'),
      },
    },
    server: {
      port: 3000,
      proxy: {
        '/api/chat': {
          target: personaplexUrl,
          changeOrigin: true,
          secure: false,
          ws: true,
        },
        '/api': {
          target: apiUrl,
          changeOrigin: true,
          secure: false,
        },
        '/recordings': {
          target: apiUrl,
          changeOrigin: true,
          secure: false,
        },
        '/meanvc': {
          target: 'https://130.237.3.103:5002',
          changeOrigin: true,
          secure: false,
          ws: true,
          rewrite: (path) => path.replace(/^\/meanvc/, ''),
        },
      },
    },
  }
})