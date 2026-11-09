import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
export default defineConfig({root:fileURLToPath(new URL('.',import.meta.url)),plugins:[react()],build:{outDir:'../../dist/customer',emptyOutDir:false},server:{port:5174,proxy:{'/api':'http://localhost:4000'}}});
