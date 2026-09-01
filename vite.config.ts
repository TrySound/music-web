import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '.', '');
  const proxyTarget = env.NAVIDROME_PROXY_TARGET;

  return {
    plugins: [svelte()],
    server: {
      host: '127.0.0.1',
      port: 5173,
      proxy: proxyTarget
        ? {
            '/navidrome': {
              target: proxyTarget,
              changeOrigin: true,
              secure: env.NAVIDROME_PROXY_SECURE !== 'false',
              rewrite: (path: string) => path.replace(/^\/navidrome/, '')
            }
          }
        : undefined
    }
  };
});
