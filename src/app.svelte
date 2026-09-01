<script lang="ts">
  import { md5 } from 'js-md5';
  import { onMount } from 'svelte';

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
      if (!value) return;

      const savedAuth: unknown = JSON.parse(value);
      if (!isSavedAuth(savedAuth)) {
        localStorage.removeItem(authStorageKey);
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

      activeAuth = { host: server, username: requestUsername, token, salt };
      localStorage.setItem(authStorageKey, JSON.stringify(activeAuth));

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

    <button type="submit" disabled={loading}>
      {loading ? 'Loading…' : 'Load artists'}
    </button>

    <small>Authentication is saved in this browser after a successful login.</small>
  </form>

  {#if error}
    <p class="error" role="alert">{error}</p>
  {/if}

  <section>
    <h2>Player</h2>
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

  <section>
    <h2>Queue</h2>
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

  {#if connectedHost && !error}
    <section aria-live="polite">
      <h2>Artists</h2>
      <p>{artists.length} artist{artists.length === 1 ? '' : 's'} from {connectedHost}</p>

      {#if artists.length > 0}
        <ul>
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
    cursor: default;
  }

  .controls {
    display: flex;
    gap: 0.5rem;
    margin-bottom: 1rem;
  }

  section > label {
    margin: 0.75rem 0;
  }

  .error {
    color: #b00020;
  }

  ul {
    padding-left: 1.5rem;
  }
</style>
