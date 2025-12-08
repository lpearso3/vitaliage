import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  base: '/dashboard/',      // 👈 important for hosting under /dashboard
  plugins: [react()],
})
