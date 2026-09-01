<script lang="ts">
  import { md5 } from 'js-md5';
  import { onMount } from 'svelte';
  import { loadLibraryCache, saveLibraryCache } from './library-cache';

  const authStorageKey = 'navidrome-auth';
  const volumeStorageKey = 'navidrome-volume';

  interface Track {
    discNumber?: number;
    id: string;
    title: string;
    track?: number;
  }

  interface QueueItem {
    album: string;
    artist: string;
    id: string;
    title: string;
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
    indexes?: { lastModified?: number | string };
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

  type View = 'library' | 'player' | 'queue' | 'settings';

  let activeView: View = 'library';
  let host = '';
  let username = '';
  let password = '';
  let artists: Artist[] = [];
  let queue: QueueItem[] = [];
  let activeAuth: SavedAuth | null = null;
  let currentIndex = -1;
  let currentTime = 0;
  let duration = 0;
  let volume = 1;
  let isPlaying = false;
  let playbackError = '';
  let audio: HTMLAudioElement;
  let loading = false;
  let refreshing = false;
  let refreshError = '';
  let error = '';
  let connectedHost = '';

  function normalizeHost(value: string) {
    const withProtocol = value.startsWith('/')
      ? new URL(value, window.location.origin).toString()
      : /^https?:\/\//i.test(value)
        ? value
        : `https://${value}`;
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
    const savedVolume = Number(localStorage.getItem(volumeStorageKey));
    if (Number.isFinite(savedVolume) && savedVolume >= 0 && savedVolume <= 1) {
      volume = savedVolume;
      audio.volume = volume;
    }

    try {
      const value = localStorage.getItem(authStorageKey);
      if (!value) {
        activeView = 'settings';
        return;
      }

      const savedAuth: unknown = JSON.parse(value);
      if (!isSavedAuth(savedAuth)) {
        localStorage.removeItem(authStorageKey);
        activeView = 'settings';
        return;
      }

      activeAuth = savedAuth;
      host = savedAuth.host;
      username = savedAuth.username;
      void loadArtists(savedAuth);
    } catch {
      localStorage.removeItem(authStorageKey);
    }
  });

  function albumQueueItems(artist: Artist, album: Album): QueueItem[] {
    return album.tracks.map((track) => ({
      album: album.name,
      artist: artist.name,
      id: track.id,
      title: track.title
    }));
  }

  function artistQueueItems(artist: Artist): QueueItem[] {
    return artist.albums.flatMap((album) => albumQueueItems(artist, album));
  }

  function trackQueueItem(artist: Artist, album: Album, track: Track): QueueItem {
    return { album: album.name, artist: artist.name, id: track.id, title: track.title };
  }

  function playAlbum(artist: Artist, album: Album) {
    replaceQueueAndPlay(albumQueueItems(artist, album));
  }

  function addAlbumToQueue(artist: Artist, album: Album) {
    queue = [...queue, ...albumQueueItems(artist, album)];
  }

  function playArtist(artist: Artist) {
    replaceQueueAndPlay(artistQueueItems(artist));
  }

  function addArtistToQueue(artist: Artist) {
    queue = [...queue, ...artistQueueItems(artist)];
  }

  function playTrack(artist: Artist, album: Album, track: Track) {
    replaceQueueAndPlay([trackQueueItem(artist, album, track)]);
  }

  function addTrackToQueue(artist: Artist, album: Album, track: Track) {
    queue = [...queue, trackQueueItem(artist, album, track)];
  }

  function streamUrl(track: QueueItem) {
    if (!activeAuth) return '';

    const query = new URLSearchParams({
      id: track.id,
      u: activeAuth.username,
      t: activeAuth.token,
      s: activeAuth.salt,
      v: '1.16.1',
      c: 'navidrome-artists'
    });
    return `${activeAuth.host}/rest/stream.view?${query}`;
  }

  function replaceQueueAndPlay(items: QueueItem[]) {
    queue = items;
    currentIndex = items.length > 0 ? 0 : -1;
    if (currentIndex >= 0) void playCurrent();
    else stopPlayback();
  }

  async function playCurrent() {
    const track = queue[currentIndex];
    const source = track ? streamUrl(track) : '';
    if (!source) return;

    playbackError = '';
    currentTime = 0;
    duration = 0;
    audio.src = source;

    try {
      await audio.play();
    } catch (caught) {
      playbackError = caught instanceof Error ? caught.message : 'Playback failed.';
    }
  }

  function stopPlayback() {
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
    currentIndex = -1;
    currentTime = 0;
    duration = 0;
    isPlaying = false;
  }

  function clearQueue() {
    stopPlayback();
    queue = [];
  }

  function togglePlayback() {
    if (audio.paused) {
      if (currentIndex < 0 && queue.length > 0) {
        currentIndex = 0;
        void playCurrent();
      } else {
        void audio.play().catch((caught: unknown) => {
          playbackError = caught instanceof Error ? caught.message : 'Playback failed.';
        });
      }
    } else {
      audio.pause();
    }
  }

  function playQueueIndex(index: number) {
    currentIndex = index;
    void playCurrent();
  }

  function nextTrack() {
    if (currentIndex + 1 >= queue.length) {
      audio.pause();
      isPlaying = false;
      return;
    }
    currentIndex += 1;
    void playCurrent();
  }

  function previousTrack() {
    if (audio.currentTime > 3 || currentIndex <= 0) {
      audio.currentTime = 0;
      return;
    }
    currentIndex -= 1;
    void playCurrent();
  }

  function seek(value: number) {
    if (Number.isFinite(value)) audio.currentTime = value;
  }

  function setVolume(value: number) {
    volume = value;
    audio.volume = value;
    localStorage.setItem(volumeStorageKey, String(value));
  }

  function formatTime(value: number) {
    if (!Number.isFinite(value)) return '0:00';
    const minutes = Math.floor(value / 60);
    const seconds = Math.floor(value % 60);
    return `${minutes}:${String(seconds).padStart(2, '0')}`;
  }

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

  async function getLastModified(
    server: string,
    authQuery: URLSearchParams,
    cachedLastModified?: number
  ) {
    const query = new URLSearchParams(authQuery);
    if (cachedLastModified !== undefined) {
      query.set('ifModifiedSince', String(cachedLastModified));
    }

    const response = await fetch(`${server}/rest/getIndexes.view?${query}`);
    if (!response.ok) throw new Error(`The server returned HTTP ${response.status}.`);

    const body: SubsonicEnvelope = await response.json();
    const result = body['subsonic-response'];
    if (!result) throw new Error('The server returned an unexpected response.');
    if (result.status !== 'ok') {
      throw new Error(result.error?.message || 'Navidrome rejected the request.');
    }

    if (!result.indexes) return cachedLastModified ?? null;
    const lastModified = Number(result.indexes.lastModified);
    return Number.isFinite(lastModified) ? lastModified : null;
  }

  async function fetchLibrary(server: string, authQuery: URLSearchParams) {
    const response = await fetch(`${server}/rest/getArtists.view?${authQuery}`);
    if (!response.ok) throw new Error(`The server returned HTTP ${response.status}.`);

    const body: SubsonicEnvelope = await response.json();
    const result = body['subsonic-response'];
    if (!result) throw new Error('The server returned an unexpected response.');
    if (result.status !== 'ok') {
      throw new Error(result.error?.message || 'Navidrome rejected the request.');
    }

    const apiAlbums = await loadAlbums(server, authQuery);
    const tracksByAlbumId = await loadTracks(server, authQuery, apiAlbums);
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
    return indexes
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
  }

  function connectionError(caught: unknown) {
    if (caught instanceof TypeError) {
      return 'Could not reach the server. Check the host and its CORS settings.';
    }
    return caught instanceof Error ? caught.message : 'Could not load artists.';
  }

  async function submitConnection(event: SubmitEvent) {
    event.preventDefault();
    await loadArtists();
    if (!error) activeView = 'library';
  }

  async function loadArtists(savedAuth?: SavedAuth) {
    loading = true;
    refreshing = false;
    error = '';
    refreshError = '';

    let hasCachedLibrary = false;

    try {
      const server = normalizeHost(savedAuth?.host ?? host.trim());
      const requestUsername = savedAuth?.username ?? username;
      const salt = savedAuth?.salt ?? createSalt();
      const token = savedAuth?.token ?? md5(password + salt);
      const credentials = { host: server, username: requestUsername, token, salt };
      const cacheKey = `${server}\n${requestUsername}`;
      const query = new URLSearchParams({
        u: requestUsername,
        t: token,
        s: salt,
        v: '1.16.1',
        c: 'navidrome-artists',
        f: 'json'
      });

      const cached = await loadLibraryCache<Artist[]>(cacheKey).catch(() => null);
      if (cached) {
        hasCachedLibrary = true;
        artists = cached.data;
        connectedHost = server;
        loading = false;
        refreshing = true;
      } else {
        artists = [];
        connectedHost = '';
      }

      activeAuth = credentials;
      const lastModified = await getLastModified(server, query, cached?.lastModified);
      localStorage.setItem(authStorageKey, JSON.stringify(credentials));

      if (cached && lastModified === cached.lastModified) return;

      refreshing = hasCachedLibrary;
      const freshArtists = await fetchLibrary(server, query);
      await saveLibraryCache(cacheKey, {
        data: freshArtists,
        lastModified: lastModified ?? 0,
        savedAt: Date.now()
      });

      artists = freshArtists;
      connectedHost = server;
    } catch (caught) {
      const message = connectionError(caught);
      if (hasCachedLibrary) {
        refreshError = `Background refresh failed: ${message}`;
      } else {
        error = message;
      }
    } finally {
      loading = false;
      refreshing = false;
    }
  }
</script>

<svelte:head>
  <title>Navidrome Artists</title>
</svelte:head>

<main class="app-shell">
  <section class="view settings-view" class:hidden={activeView !== 'settings'}>
    <h2>Connect to your music</h2>
    <p class="muted">Enter your Navidrome server details. Authentication stays on this device.</p>
    <form onsubmit={submitConnection}>
    <label>
      Host
      <input
        type="text"
        bind:value={host}
        placeholder="https://music.example.com or /navidrome"
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

    <button type="submit" disabled={loading || refreshing}>
      {loading ? 'Loading…' : refreshing ? 'Refreshing…' : 'Load artists'}
    </button>

      <small>Authentication is saved in this browser after a successful login.</small>
    </form>
  </section>

  {#if error}
    <p class="error" role="alert">{error}</p>
  {/if}

  {#if refreshError}
    <p class="error">{refreshError} Cached metadata is still being shown.</p>
  {:else if refreshing}
    <p>Refreshing metadata in the background…</p>
  {/if}

  <section class="view player-view" class:hidden={activeView !== 'player'}>
    <div class="artwork">♫</div>
    <audio
      bind:this={audio}
      preload="metadata"
      onplay={() => isPlaying = true}
      onpause={() => isPlaying = false}
      onended={nextTrack}
      ontimeupdate={() => currentTime = audio.currentTime}
      onloadedmetadata={() => duration = audio.duration}
      onerror={() => {
        if (audio.currentSrc) playbackError = 'The track could not be played.';
      }}
    ></audio>

    {#if currentIndex >= 0 && queue[currentIndex]}
      <p>
        <strong>{queue[currentIndex].title}</strong><br />
        {queue[currentIndex].artist} — {queue[currentIndex].album}
      </p>
    {:else}
      <p>Nothing is playing.</p>
    {/if}

    <div class="controls">
      <button type="button" onclick={previousTrack} disabled={currentIndex <= 0}>Previous</button>
      <button type="button" onclick={togglePlayback} disabled={queue.length === 0}>
        {isPlaying ? 'Pause' : 'Play'}
      </button>
      <button
        type="button"
        onclick={nextTrack}
        disabled={currentIndex < 0 || currentIndex + 1 >= queue.length}>Next</button
      >
    </div>

    <label>
      Position: {formatTime(currentTime)} / {formatTime(duration)}
      <input
        type="range"
        min="0"
        max={Number.isFinite(duration) ? duration : 0}
        step="0.1"
        value={currentTime}
        disabled={!duration}
        oninput={(event) => seek(event.currentTarget.valueAsNumber)}
      />
    </label>

    <label>
      Volume: {Math.round(volume * 100)}%
      <input
        type="range"
        min="0"
        max="1"
        step="0.01"
        value={volume}
        oninput={(event) => setVolume(event.currentTarget.valueAsNumber)}
      />
    </label>

    {#if playbackError}
      <p class="error">{playbackError}</p>
    {/if}
  </section>

  <section class="view queue-view" class:hidden={activeView !== 'queue'}>
    <div class="section-heading">
      <div>
        <span class="eyebrow">Up next</span>
        <h2>{queue.length} track{queue.length === 1 ? '' : 's'}</h2>
      </div>
    </div>
    {#if queue.length > 0}
      <button type="button" onclick={clearQueue}>Clear queue</button>
      <ol>
        {#each queue as item, index}
          <li><strong>{index === currentIndex ? '▶ ' : ''}</strong>{item.title} — {item.artist}, {item.album}</li>
        {/each}
      </ol>
    {:else}
      <p>The queue is empty.</p>
    {/if}
  </section>

  <section class="view library-view" class:hidden={activeView !== 'library'}>
    {#if connectedHost && !error}
      <div class="section-heading">
        <div>
          <span class="eyebrow">Your music</span>
          <h2>{artists.length} artist{artists.length === 1 ? '' : 's'}</h2>
        </div>
        <button type="button" class="quiet" onclick={() => loadArtists(activeAuth ?? undefined)} disabled={loading || refreshing}>
          {refreshing ? 'Checking…' : 'Refresh'}
        </button>
      </div>

      {#if artists.length > 0}
        <ul class="music-list">
          {#each artists as artist}
            <li>
              <details>
                <summary>
                  <strong>{artist.name}</strong>
                  <button
                    type="button"
                    onclick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      playArtist(artist);
                    }}>▶ Play</button
                  >
                  <button
                    type="button"
                    onclick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      addArtistToQueue(artist);
                    }}>+ Add</button
                  >
                </summary>
                {#if artist.albums.length > 0}
                  <ul>
                    {#each artist.albums as album}
                      <li>
                        <details>
                          <summary>
                            {album.name}{album.year ? ` (${album.year})` : ''}
                            <button
                              type="button"
                              onclick={(event) => {
                                event.preventDefault();
                                event.stopPropagation();
                                playAlbum(artist, album);
                              }}>▶ Play</button
                            >
                            <button
                              type="button"
                              onclick={(event) => {
                                event.preventDefault();
                                event.stopPropagation();
                                addAlbumToQueue(artist, album);
                              }}>+ Add</button
                            >
                          </summary>
                          {#if album.tracks.length > 0}
                            <ul>
                              {#each album.tracks as track}
                                <li>
                                  {track.track ? `${track.track}. ` : ''}{track.title}
                                  <button
                                    type="button"
                                    onclick={() => playTrack(artist, album, track)}>▶ Play</button
                                  >
                                  <button
                                    type="button"
                                    onclick={() => addTrackToQueue(artist, album, track)}>+ Add</button
                                  >
                                </li>
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
        <div class="empty-state">
          <span>♫</span>
          <p>No artists found.</p>
        </div>
      {/if}
    {:else if !loading}
      <div class="empty-state">
        <span>♫</span>
        <h2>Connect your library</h2>
        <p>Add your Navidrome server to start listening.</p>
        <button type="button" class="primary" onclick={() => activeView = 'settings'}>Open settings</button>
      </div>
    {/if}
  </section>

  {#if currentIndex >= 0 && queue[currentIndex] && activeView !== 'player'}
    <button type="button" class="mini-player" onclick={() => activeView = 'player'}>
      <span class="mini-art">♫</span>
      <span class="mini-copy">
        <strong>{queue[currentIndex].title}</strong>
        <small>{queue[currentIndex].artist}</small>
      </span>
      <span
        class="mini-control"
        role="button"
        tabindex="0"
        onclick={(event) => {
          event.stopPropagation();
          togglePlayback();
        }}
        onkeydown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') togglePlayback();
        }}>{isPlaying ? 'Ⅱ' : '▶'}</span
      >
    </button>
  {/if}

  <nav class="bottom-nav">
    <button class:active={activeView === 'library'} type="button" onclick={() => activeView = 'library'}>
      <span>♫</span><small>Library</small>
    </button>
    <button class:active={activeView === 'player'} type="button" onclick={() => activeView = 'player'}>
      <span>▶</span><small>Player</small>
    </button>
    <button class:active={activeView === 'queue'} type="button" onclick={() => activeView = 'queue'}>
      <span>≡</span><small>Queue</small>
    </button>
    <button class:active={activeView === 'settings'} type="button" onclick={() => activeView = 'settings'}>
      <span>⚙</span><small>Settings</small>
    </button>
  </nav>
</main>

<style>
  :global(body) {
    background: #080a0f;
    color: #f5f6f8;
  }

  .app-shell {
    position: relative;
    width: 100%;
    max-width: 32rem;
    min-height: 100dvh;
    margin: 0 auto;
    padding-bottom: 10.5rem;
    background: #10131a;
  }

  h2,
  p {
    margin-top: 0;
  }

  h2 {
    margin-bottom: 0.5rem;
    font-size: 1.25rem;
  }

  .eyebrow {
    display: block;
    margin-bottom: 0.15rem;
    color: #979ead;
    font-size: 0.7rem;
    font-weight: 700;
    letter-spacing: 0.12em;
    text-transform: uppercase;
  }

  .view {
    padding: 1.25rem;
  }

  .hidden {
    display: none;
  }

  .muted,
  small {
    color: #979ead;
  }

  form,
  label {
    display: grid;
    gap: 0.45rem;
  }

  form {
    gap: 1rem;
    margin-top: 1.5rem;
  }

  input:not([type='range']) {
    width: 100%;
    padding: 0.8rem 0.9rem;
    border: 1px solid #343a48;
    border-radius: 0.7rem;
    outline: none;
    color: #f5f6f8;
    background: #191d27;
  }

  input:not([type='range']):focus {
    border-color: #8d7dff;
  }

  input[type='range'] {
    width: 100%;
    accent-color: #8d7dff;
  }

  button {
    border: 0;
    border-radius: 999px;
    color: #f5f6f8;
    background: #292f3c;
    font: inherit;
    font-size: 0.82rem;
    font-weight: 650;
  }

  button:disabled {
    opacity: 0.4;
  }

  form > button,
  .primary {
    min-height: 2.8rem;
    padding: 0.7rem 1.1rem;
    background: #7565f6;
  }

  .section-heading {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    margin-bottom: 1rem;
  }

  .section-heading h2 {
    margin: 0;
  }

  .quiet {
    padding: 0.55rem 0.8rem;
    color: #bcb4ff;
    background: #252438;
  }

  .artwork {
    display: grid;
    width: min(76vw, 21rem);
    aspect-ratio: 1;
    margin: 1rem auto 2rem;
    place-items: center;
    border-radius: 1.5rem;
    color: rgb(255 255 255 / 85%);
    background: linear-gradient(145deg, #7665f6, #d35b91);
    box-shadow: 0 1.5rem 3.5rem rgb(0 0 0 / 38%);
    font-size: 5rem;
  }

  .player-view > p {
    margin-bottom: 1.4rem;
    text-align: center;
  }

  .player-view > p strong {
    font-size: 1.25rem;
  }

  .player-view label {
    margin-top: 1.25rem;
    color: #b8bec9;
    font-size: 0.78rem;
  }

  .controls {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.75rem;
  }

  .controls button {
    min-width: 4.7rem;
    min-height: 2.8rem;
    padding: 0.6rem;
  }

  .controls button:nth-child(2) {
    min-width: 4.2rem;
    min-height: 4.2rem;
    background: #7565f6;
  }

  .music-list,
  .music-list ul {
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .music-list > li {
    margin-bottom: 0.65rem;
    overflow: hidden;
    border: 1px solid #272c38;
    border-radius: 0.85rem;
    background: #171b23;
  }

  .music-list summary {
    display: flex;
    align-items: center;
    gap: 0.45rem;
    min-height: 3.25rem;
    padding: 0.7rem 0.8rem;
    cursor: pointer;
  }

  .music-list summary strong,
  .music-list summary::marker {
    color: #f5f6f8;
  }

  .music-list summary strong,
  .music-list details details summary {
    flex: 1;
  }

  .music-list summary button {
    flex: none;
    padding: 0.45rem 0.65rem;
  }

  .music-list details > ul {
    border-top: 1px solid #272c38;
  }

  .music-list details details {
    border-bottom: 1px solid #252a34;
    background: #12161d;
  }

  .music-list details details > ul {
    padding: 0.35rem 0.8rem 0.7rem 2rem;
  }

  .music-list details details > ul li {
    padding: 0.45rem 0;
    color: #c9ced7;
  }

  .music-list details details > ul button {
    margin-left: 0.3rem;
    padding: 0.35rem 0.55rem;
  }

  .queue-view ol {
    margin: 1rem 0 0;
    padding: 0;
    list-style: none;
  }

  .queue-view ol li {
    padding: 0.85rem 0;
    border-bottom: 1px solid #272c38;
    color: #c9ced7;
  }

  .empty-state {
    display: grid;
    min-height: 55dvh;
    place-items: center;
    align-content: center;
    padding: 2rem;
    text-align: center;
  }

  .empty-state > span {
    display: grid;
    width: 5rem;
    height: 5rem;
    margin-bottom: 1rem;
    place-items: center;
    border-radius: 1.4rem;
    color: #bcb4ff;
    background: #252438;
    font-size: 2rem;
  }

  .empty-state p {
    color: #979ead;
  }

  .error {
    margin: 0.75rem 1.25rem;
    padding: 0.75rem;
    border-radius: 0.7rem;
    color: #ff9aa9;
    background: #351c25;
    font-size: 0.85rem;
  }

  .mini-player {
    position: fixed;
    z-index: 20;
    right: 0.6rem;
    bottom: 4.8rem;
    left: 0.6rem;
    display: flex;
    max-width: 30.8rem;
    min-height: 4rem;
    margin: 0 auto;
    padding: 0.5rem;
    align-items: center;
    gap: 0.7rem;
    border: 1px solid #343a48;
    border-radius: 0.9rem;
    text-align: left;
    background: #1c212b;
    box-shadow: 0 0.8rem 2rem rgb(0 0 0 / 45%);
  }

  .mini-art {
    display: grid;
    width: 3rem;
    height: 3rem;
    flex: none;
    place-items: center;
    border-radius: 0.65rem;
    background: linear-gradient(145deg, #7665f6, #d35b91);
  }

  .mini-copy {
    display: grid;
    min-width: 0;
    flex: 1;
  }

  .mini-copy strong,
  .mini-copy small {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .mini-control {
    display: grid;
    width: 2.7rem;
    height: 2.7rem;
    place-items: center;
    border-radius: 50%;
    background: #7565f6;
  }

  .bottom-nav {
    position: fixed;
    z-index: 20;
    right: 0;
    bottom: 0;
    left: 0;
    display: grid;
    width: 100%;
    max-width: 32rem;
    min-height: 4.25rem;
    margin: 0 auto;
    padding: 0.35rem 0.4rem max(0.35rem, env(safe-area-inset-bottom));
    grid-template-columns: repeat(4, 1fr);
    border-top: 1px solid #292f3b;
    background: rgb(17 20 27 / 97%);
    backdrop-filter: blur(14px);
  }

  .bottom-nav button {
    display: grid;
    gap: 0.15rem;
    place-items: center;
    border-radius: 0.65rem;
    color: #8f96a5;
    background: transparent;
    font-size: 1.05rem;
  }

  .bottom-nav button.active {
    color: #bcb4ff;
    background: #222332;
  }

  .bottom-nav small {
    color: inherit;
    font-size: 0.65rem;
  }
</style>
