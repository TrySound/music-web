# Navidrome Artists

A small client-only Svelte + Vite app that signs in to a Navidrome server and lists its artists through the Subsonic API.

## Run

```sh
pnpm install
pnpm dev
```

The Navidrome server must allow browser requests from the app's origin (CORS), and HTTPS should be used outside local development.

## Development proxy

To avoid CORS during local development, copy the example environment file and set your Navidrome URL:

```sh
cp .env.example .env
```

```dotenv
NAVIDROME_PROXY_TARGET=https://music.example.com
```

Start Vite and enter `/navidrome` in the Host field. Set `NAVIDROME_PROXY_SECURE=false` only when Navidrome uses a self-signed development certificate.
