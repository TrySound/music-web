<script lang="ts">
  import { md5 } from 'js-md5';

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

  async function loadArtists() {
    loading = true;
    error = '';
    artists = [];

    try {
      const server = normalizeHost(host.trim());
      const salt = createSalt();
      const query = new URLSearchParams({
        u: username,
        t: md5(password + salt),
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
