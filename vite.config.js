import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { nodePolyfills } from 'vite-plugin-node-polyfills';
import { resolve } from 'path';

export default defineConfig({
  resolve: {
    // @sqds/multisig@2.1.4 declares index.mjs in exports but never ships it;
    // alias directly to the CJS bundle to bypass the broken exports field.
    alias: {
      '@sqds/multisig': resolve('node_modules/@sqds/multisig/lib/index.js'),
    },
  },
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
