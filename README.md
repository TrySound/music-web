# Navidrome Artists

A small client-only Svelte + Vite app that signs in to a Navidrome server and lists its artists through the Subsonic API.

## Run

```sh
pnpm install
pnpm dev
```

The Navidrome server must allow browser requests from the app's origin (CORS), and HTTPS should be used outside local development.
