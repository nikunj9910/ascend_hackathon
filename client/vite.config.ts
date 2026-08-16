import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    fs: {
      // Allow importing the repo-root /fixtures JSON files directly, so the
      // Replay page's fixture picker stays a single source of truth instead
      // of duplicating fixture data into the client.
      allow: [path.resolve(__dirname, '.'), path.resolve(__dirname, '..')],
    },
  },
});
