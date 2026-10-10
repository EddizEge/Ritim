import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// `base` stays '/': Android (Capacitor), the PWA and the Sync server's dist/
// all rely on absolute asset paths. The Electron Social view loads
// desktop-social.html from a privileged scheme (electron/social-page.cjs).
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
  },
  build: {
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        desktopSocial: fileURLToPath(new URL('./desktop-social.html', import.meta.url)),
      },
    },
  },
})
