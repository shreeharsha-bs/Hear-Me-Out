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
      '/api': {
        target: 'http://130.237.3.103:5001',
        changeOrigin: true,
      },
      '/recordings': {
        target: 'http://130.237.3.103:5001',
        changeOrigin: true,
      },
    },
  },
})
