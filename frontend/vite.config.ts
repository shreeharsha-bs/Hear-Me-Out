import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
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
        target: 'https://130.237.3.103:8000',
        changeOrigin: true,
        secure: false,
        ws: true,
      },
      '/api': {
        target: 'https://130.237.3.103:5001',
        changeOrigin: true,
        secure: false,
      },
      '/recordings': {
        target: 'https://130.237.3.103:5001',
        changeOrigin: true,
        secure: false,
      },
    },
  },
})