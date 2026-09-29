import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// Separate from vite.config.ts, whose root is client/ (the SPA); tests live at the package root.
export default defineConfig({ plugins: [react()], test: { root: '.' } });
