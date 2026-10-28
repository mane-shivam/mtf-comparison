import { defineConfig } from 'vite';

// Relative base so the same build works at the domain root (Vercel) and under /<repo>/ (GitHub Pages).
export default defineConfig({
  base: './',
});
