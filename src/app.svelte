<script lang="ts">
  import { md5 } from 'js-md5';
  import { onMount } from 'svelte';

  const authStorageKey = 'navidrome-auth';

  interface Track {
    discNumber?: number;
    id: string;
    title: string;
    track?: number;
  }

  interface Album {
    artist?: string;
    artistId?: string;
    id: string;
    name: string;
    tracks: Track[];
    year?: number;
  }

  type ApiAlbum = Omit<Album, 'tracks'>;

  interface Artist {
    albums: Album[];
    id?: string;
    name: string;
  }

  type ApiArtist = Omit<Artist, 'albums'>;

  interface ArtistIndex {
    artist?: ApiArtist[];
  }

  interface SubsonicResponse {
    status: string;
    error?: { message?: string };
    artists?: { index?: ArtistIndex[] };
    albumList2?: { album?: ApiAlbum[] };
    album?: { song?: Track[] };
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

  async function loadAlbums(server: string, authQuery: URLSearchParams) {
    const albums: ApiAlbum[] = [];
    const pageSize = 500;

    for (let offset = 0; ; offset += pageSize) {
      const query = new URLSearchParams(authQuery);
      query.set('type', 'alphabeticalByArtist');
      query.set('size', String(pageSize));
      query.set('offset', String(offset));

      const response = await fetch(`${server}/rest/getAlbumList2.view?${query}`);
      if (!response.ok) throw new Error(`The server returned HTTP ${response.status}.`);

      const body: SubsonicEnvelope = await response.json();
      const result = body['subsonic-response'];
      if (!result) throw new Error('The server returned an unexpected response.');
      if (result.status !== 'ok') {
        throw new Error(result.error?.message || 'Navidrome rejected the request.');
      }

      const page = result.albumList2?.album ?? [];
      albums.push(...page);
      if (page.length < pageSize) return albums;
    }
  }

  async function loadTracks(
    server: string,
    authQuery: URLSearchParams,
    albums: ApiAlbum[]
  ) {
    const tracksByAlbumId = new Map<string, Track[]>();
    let nextAlbum = 0;

    async function worker() {
      while (nextAlbum < albums.length) {
        const album = albums[nextAlbum++];
        const query = new URLSearchParams(authQuery);
        query.set('id', album.id);

        const response = await fetch(`${server}/rest/getAlbum.view?${query}`);
        if (!response.ok) throw new Error(`The server returned HTTP ${response.status}.`);

        const body: SubsonicEnvelope = await response.json();
        const result = body['subsonic-response'];
        if (!result) throw new Error('The server returned an unexpected response.');
        if (result.status !== 'ok') {
          throw new Error(result.error?.message || 'Navidrome rejected the request.');
        }

        const tracks = result.album?.song ?? [];
        tracksByAlbumId.set(
          album.id,
          tracks.sort(
            (a, b) => (a.discNumber ?? 1) - (b.discNumber ?? 1) ||
              (a.track ?? Number.MAX_SAFE_INTEGER) - (b.track ?? Number.MAX_SAFE_INTEGER) ||
              a.title.localeCompare(b.title)
          )
        );
      }
    }

    await Promise.all(Array.from({ length: Math.min(6, albums.length) }, () => worker()));
    return tracksByAlbumId;
  }

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

      const apiAlbums = await loadAlbums(server, query);
      const tracksByAlbumId = await loadTracks(server, query, apiAlbums);
      const albumsByArtistId = new Map<string, Album[]>();
      const albumsByArtistName = new Map<string, Album[]>();

      for (const apiAlbum of apiAlbums) {
        const album: Album = {
          ...apiAlbum,
          tracks: tracksByAlbumId.get(apiAlbum.id) ?? []
        };
        const map = album.artistId ? albumsByArtistId : albumsByArtistName;
        const key = album.artistId ?? album.artist;
        if (!key) continue;
        map.set(key, [...(map.get(key) ?? []), album]);
      }

      const indexes = result.artists?.index ?? [];
      artists = indexes
        .flatMap((index) => index.artist ?? [])
        .map((artist) => ({
          ...artist,
          albums:
            (artist.id ? albumsByArtistId.get(artist.id) : undefined) ??
            albumsByArtistName.get(artist.name) ??
            []
        }))
        .map((artist) => ({
          ...artist,
          albums: artist.albums.sort(
            (a, b) => (a.year ?? Number.MAX_SAFE_INTEGER) - (b.year ?? Number.MAX_SAFE_INTEGER) ||
              a.name.localeCompare(b.name)
          )
        }))
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
            <li>
              <details>
                <summary><strong>{artist.name}</strong></summary>
                {#if artist.albums.length > 0}
                  <ul>
                    {#each artist.albums as album}
                      <li>
                        <details>
                          <summary>{album.name}{album.year ? ` (${album.year})` : ''}</summary>
                          {#if album.tracks.length > 0}
                            <ul>
                              {#each album.tracks as track}
                                <li>{track.track ? `${track.track}. ` : ''}{track.title}</li>
                              {/each}
                            </ul>
                          {:else}
                            <span>No tracks</span>
                          {/if}
                        </details>
                      </li>
                    {/each}
                  </ul>
                {:else}
                  <span>No albums</span>
                {/if}
              </details>
            </li>
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
