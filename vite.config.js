import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { nodePolyfills } from 'vite-plugin-node-polyfills';

export default defineConfig({
  plugins: [
    react(),
    nodePolyfills({
      include: ['buffer', 'crypto', 'stream', 'util', 'process', 'events'],
      globals: { Buffer: true, global: true, process: true },
    }),
  ],
  build: {
    target: 'esnext',
    rollupOptions: {
      output: {
        manualChunks: {
          solana: ['@solana/web3.js', '@solana/wallet-adapter-base', '@solana/wallet-adapter-react'],
          squads: ['@sqds/multisig'],
        },
      },
    },
  },
  optimizeDeps: {
    include: ['@solana/web3.js'],
    esbuildOptions: {
      target: 'esnext',
    },
  },
  define: {
    'process.env': '{}',
  },
});
