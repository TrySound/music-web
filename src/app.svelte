<script lang="ts">
  import { md5 } from 'js-md5';
  import { onMount } from 'svelte';

  const authStorageKey = 'navidrome-auth';

  interface Artist {
    id?: string;
    name: string;
  }

  interface ArtistIndex {
    artist?: Artist[];
  }

  interface SubsonicResponse {
    status: string;
    error?: { message?: string };
    artists?: { index?: ArtistIndex[] };
  }

  interface SubsonicEnvelope {
    'subsonic-response'?: SubsonicResponse;
  }

  interface SavedAuth {
    host: string;
    username: string;
    token: string;
    salt: string;
  }

  let host = '';
  let username = '';
  let password = '';
  let artists: Artist[] = [];
  let loading = false;
  let error = '';
  let connectedHost = '';

  function normalizeHost(value: string) {
    const withProtocol = /^https?:\/\//i.test(value) ? value : `https://${value}`;
    const url = new URL(withProtocol);
    return url.toString().replace(/\/$/, '');
  }

  function createSalt() {
    const bytes = crypto.getRandomValues(new Uint8Array(12));
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  }

  function isSavedAuth(value: unknown): value is SavedAuth {
    if (!value || typeof value !== 'object') return false;

    const auth = value as Record<string, unknown>;
    return ['host', 'username', 'token', 'salt'].every(
      (key) => typeof auth[key] === 'string' && auth[key].length > 0
    );
  }

  onMount(() => {
    try {
      const value = localStorage.getItem(authStorageKey);
      if (!value) return;

      const savedAuth: unknown = JSON.parse(value);
      if (!isSavedAuth(savedAuth)) {
        localStorage.removeItem(authStorageKey);
        return;
      }

      host = savedAuth.host;
      username = savedAuth.username;
      void loadArtists(savedAuth);
    } catch {
      localStorage.removeItem(authStorageKey);
    }
  });

  async function loadArtists(savedAuth?: SavedAuth) {
    loading = true;
    error = '';
    artists = [];

    try {
      const server = normalizeHost(savedAuth?.host ?? host.trim());
      const requestUsername = savedAuth?.username ?? username;
      const salt = savedAuth?.salt ?? createSalt();
      const token = savedAuth?.token ?? md5(password + salt);
      const query = new URLSearchParams({
        u: requestUsername,
        t: token,
        s: salt,
        v: '1.16.1',
        c: 'navidrome-artists',
        f: 'json'
      });
      const response = await fetch(`${server}/rest/getArtists.view?${query}`);

      if (!response.ok) {
        throw new Error(`The server returned HTTP ${response.status}.`);
      }

      const body: SubsonicEnvelope = await response.json();
      const result = body['subsonic-response'];

      if (!result) {
        throw new Error('The server returned an unexpected response.');
      }

      if (result.status !== 'ok') {
        throw new Error(result.error?.message || 'Navidrome rejected the request.');
      }

      localStorage.setItem(
        authStorageKey,
        JSON.stringify({ host: server, username: requestUsername, token, salt } satisfies SavedAuth)
      );

      const indexes = result.artists?.index ?? [];
      artists = indexes
        .flatMap((index) => index.artist ?? [])
        .sort((a, b) => a.name.localeCompare(b.name));
      connectedHost = server;
    } catch (caught) {
      if (caught instanceof TypeError) {
        error = 'Could not reach the server. Check the host and its CORS settings.';
      } else {
        error = caught instanceof Error ? caught.message : 'Could not load artists.';
      }
    } finally {
      loading = false;
    }
  }
</script>

<svelte:head>
  <title>Navidrome Artists</title>
</svelte:head>

<main>
  <h1>Navidrome artists</h1>

  <form onsubmit={(event) => { event.preventDefault(); loadArtists(); }}>
    <label>
      Host
      <input
        type="text"
        bind:value={host}
        placeholder="https://music.example.com"
        autocomplete="url"
        required
      />
    </label>

    <label>
      Username
      <input type="text" bind:value={username} autocomplete="username" required />
    </label>

    <label>
      Password
      <input type="password" bind:value={password} autocomplete="current-password" required />
    </label>

    <button type="submit" disabled={loading}>
      {loading ? 'Loading…' : 'Load artists'}
    </button>

    <small>Authentication is saved in this browser after a successful login.</small>
  </form>

  {#if error}
    <p class="error" role="alert">{error}</p>
  {/if}

  {#if connectedHost && !error}
    <section aria-live="polite">
      <h2>Artists</h2>
      <p>{artists.length} artist{artists.length === 1 ? '' : 's'} from {connectedHost}</p>

      {#if artists.length > 0}
        <ul>
          {#each artists as artist}
            <li>{artist.name}</li>
          {/each}
        </ul>
      {:else}
        <p>No artists found.</p>
      {/if}
    </section>
  {/if}
</main>

<style>
  main {
    width: min(100% - 2rem, 42rem);
    margin: 2rem auto;
  }

  form {
    display: grid;
    gap: 1rem;
    padding-bottom: 1.5rem;
    border-bottom: 1px solid #ccc;
  }

  label {
    display: grid;
    gap: 0.25rem;
  }

  input {
    width: 100%;
    padding: 0.5rem;
    border: 1px solid #999;
    border-radius: 0.2rem;
  }

  button {
    width: fit-content;
    padding: 0.5rem 0.8rem;
  }

  button:disabled {
    cursor: wait;
  }

  .error {
    color: #b00020;
  }

  ul {
    padding-left: 1.5rem;
  }
</style>
