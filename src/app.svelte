<script lang="ts">
  import { md5 } from 'js-md5';
  import { onMount } from 'svelte';
  import { loadLibraryCache, saveLibraryCache } from './library-cache';

  const authStorageKey = 'navidrome-auth';

  interface Track {
    coverArt?: string;
    discNumber?: number;
    id: string;
    title: string;
    track?: number;
  }

  interface QueueItem {
    album: string;
    artist: string;
    coverArt?: string;
    id: string;
    title: string;
  }

  interface Album {
    artist?: string;
    artistId?: string;
    coverArt?: string;
    id: string;
    name: string;
    tracks: Track[];
    year?: number;
  }

  type ApiAlbum = Omit<Album, 'tracks'>;

  interface Artist {
    albums: Album[];
    coverArt?: string;
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

  type View = 'library' | 'player' | 'settings';

  let activeView: View = 'library';
  let selectedArtist: Artist | null = null;
  let selectedAlbum: Album | null = null;
  let host = '';
  let username = '';
  let password = '';
  let artists: Artist[] = [];
  let queue: QueueItem[] = [];
  let activeAuth: SavedAuth | null = null;
  let currentIndex = -1;
  let currentTime = 0;
  let duration = 0;
  let isPlaying = false;
  let playbackError = '';
  let audio: HTMLAudioElement;
  let loading = false;
  let refreshing = false;
  let refreshError = '';
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

  function applyRoute(destination: string, resetScroll = false) {
    if (resetScroll) window.scrollTo({ top: 0, behavior: 'instant' });

    const url = new URL(destination);
    const parts = url.hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);

    if (parts[0] === 'player' || parts[0] === 'queue') {
      activeView = 'player';
      return;
    }

    if (parts[0] === 'settings') {
      activeView = 'settings';
      return;
    }

    activeView = 'library';
    selectedArtist = null;
    selectedAlbum = null;

    if (parts[0] !== 'library' || parts[1] !== 'artist' || !parts[2]) return;
    selectedArtist = artists.find((artist) => (artist.id ?? artist.name) === parts[2]) ?? null;

    if (selectedArtist && parts[3] === 'album' && parts[4]) {
      selectedAlbum = selectedArtist.albums.find((album) => album.id === parts[4]) ?? null;
    }
  }

  function navigateTo(hash: string, history: 'push' | 'replace' = 'push') {
    void window.navigation.navigate(hash, { history }).finished?.catch(() => {});
  }

  function syncCurrentRoute() {
    applyRoute(window.navigation.currentEntry?.url ?? window.location.href);
  }

  onMount(() => {
    const handleNavigation = (event: NavigateEvent) => {
      const destination = new URL(event.destination.url);
      if (!event.canIntercept || destination.origin !== window.location.origin || !destination.hash.startsWith('#/')) return;

      event.intercept({ handler: () => applyRoute(destination.toString(), true) });
    };

    window.navigation.addEventListener('navigate', handleNavigation);
    if (window.location.hash.startsWith('#/')) syncCurrentRoute();
    else navigateTo('#/library', 'replace');

    return () => window.navigation.removeEventListener('navigate', handleNavigation);
  });

  onMount(() => {
    try {
      const value = localStorage.getItem(authStorageKey);
      if (!value) {
        navigateTo('#/settings', 'replace');
        return;
      }

      const savedAuth: unknown = JSON.parse(value);
      if (!isSavedAuth(savedAuth)) {
        localStorage.removeItem(authStorageKey);
        navigateTo('#/settings', 'replace');
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

  function artistRoute(artist: Artist) {
    return `#/library/artist/${encodeURIComponent(artist.id ?? artist.name)}`;
  }

  function albumRoute(artist: Artist, album: Album) {
    return `${artistRoute(artist)}/album/${encodeURIComponent(album.id)}`;
  }

  function coverArtUrl(id?: string) {
    if (!id || !activeAuth) return '';

    const query = new URLSearchParams({
      id,
      u: activeAuth.username,
      t: activeAuth.token,
      s: activeAuth.salt,
      v: '1.16.1',
      c: 'navidrome-artists',
      size: '500'
    });
    return `${activeAuth.host}/rest/getCoverArt.view?${query}`;
  }

  function artistCoverArt(artist: Artist) {
    return artist.coverArt ?? artist.albums.find((album) => album.coverArt)?.coverArt;
  }

  function albumQueueItems(artist: Artist, album: Album): QueueItem[] {
    return album.tracks.map((track) => ({
      album: album.name,
      artist: artist.name,
      coverArt: track.coverArt ?? album.coverArt ?? artistCoverArt(artist),
      id: track.id,
      title: track.title
    }));
  }

  function artistQueueItems(artist: Artist): QueueItem[] {
    return artist.albums.flatMap((album) => albumQueueItems(artist, album));
  }

  function trackQueueItem(artist: Artist, album: Album, track: Track): QueueItem {
    return {
      album: album.name,
      artist: artist.name,
      coverArt: track.coverArt ?? album.coverArt ?? artistCoverArt(artist),
      id: track.id,
      title: track.title
    };
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

  function playbackPercent() {
    if (!Number.isFinite(duration) || duration <= 0) return 0;
    return Math.min(100, Math.max(0, (currentTime / duration) * 100));
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
    if (!error) navigateTo('#/library');
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
        syncCurrentRoute();
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
      syncCurrentRoute();
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
  {/if}

  <section class="view player-view" class:hidden={activeView !== 'player'}>
    <div class="player-main">
      <div class="artwork">
      {#if currentIndex >= 0 && queue[currentIndex] && coverArtUrl(queue[currentIndex].coverArt)}
        <img src={coverArtUrl(queue[currentIndex].coverArt)} alt="" />
      {:else}
        <span>♫</span>
      {/if}
    </div>
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
    {/if}

    <div class="playback-progress">
      <input
        class="playback-slider"
        type="range"
        min="0"
        max={Number.isFinite(duration) ? duration : 0}
        step="0.1"
        value={currentTime}
        disabled={!duration}
        oninput={(event) => seek(event.currentTarget.valueAsNumber)}
      />
      <div class="playback-time">
        <span>{formatTime(currentTime)}</span>
        <span>{formatTime(duration)}</span>
      </div>
    </div>

    <div class="controls">
      <button type="button" onclick={previousTrack} disabled={currentIndex <= 0} title="Previous">⏮</button>
      <button type="button" class="play-control" onclick={togglePlayback} disabled={queue.length === 0} title={isPlaying ? 'Pause' : 'Play'}>
        {isPlaying ? 'Ⅱ' : '▶'}
      </button>
      <button type="button" onclick={nextTrack} disabled={currentIndex < 0 || currentIndex + 1 >= queue.length} title="Next">⏭</button>
    </div>

      {#if playbackError}
        <p class="error">{playbackError}</p>
      {/if}
    </div>

    <div class="player-queue">
      <div class="section-heading">
        <div>
          <span class="eyebrow">Up next</span>
          <h2>{queue.length} track{queue.length === 1 ? '' : 's'}</h2>
        </div>
        {#if queue.length > 0}
          <button type="button" class="quiet" onclick={clearQueue}>Clear</button>
        {/if}
      </div>
      {#if queue.length > 0}
        <div class="track-list">
          {#each queue as item, index}
            <div class="track-row" class:current={index === currentIndex}>
              <button type="button" class="track-main" onclick={() => playQueueIndex(index)}>
                <span class="track-number">{index === currentIndex ? '▶' : index + 1}</span>
                <span>{item.title}</span>
              </button>
              <button type="button" class="row-action" onclick={() => playQueueIndex(index)}>▶</button>
            </div>
          {/each}
        </div>
      {:else}
        <p class="muted">The queue is empty.</p>
      {/if}
    </div>
  </section>

  <section class="view library-view" class:hidden={activeView !== 'library'}>
    {#if connectedHost && !error}
      {#if selectedArtist}
        <a class="back-button" href={selectedAlbum ? artistRoute(selectedArtist) : '#/library'}>‹ Back</a>
      {/if}

      <div class="section-heading">
        <div>
          <span class="eyebrow">
            {selectedAlbum ? selectedArtist?.name : selectedArtist ? 'Albums' : 'Your music'}
          </span>
          <h2>{selectedAlbum?.name ?? selectedArtist?.name ?? `${artists.length} artists`}</h2>
        </div>
      </div>

      {#if selectedArtist && selectedAlbum}
        <div class="track-list">
          {#each selectedAlbum.tracks as track, index}
            <div class="track-row">
              <button type="button" class="track-main" onclick={() => playTrack(selectedArtist!, selectedAlbum!, track)}>
                <span class="track-number">{track.track ?? index + 1}</span>
                <span>{track.title}</span>
              </button>
              <button type="button" class="row-action" onclick={() => playTrack(selectedArtist!, selectedAlbum!, track)}>▶</button>
              <button type="button" class="row-action" onclick={() => addTrackToQueue(selectedArtist!, selectedAlbum!, track)}>＋</button>
            </div>
          {:else}
            <div class="empty-state"><p>No tracks found.</p></div>
          {/each}
        </div>
      {:else if selectedArtist}
        <div class="album-list">
          {#each selectedArtist.albums as album}
            <article class="album-row">
              <a class="album-main" href={albumRoute(selectedArtist, album)}>
                <span class="cover album-cover">
                  {#if coverArtUrl(album.coverArt)}
                    <img src={coverArtUrl(album.coverArt)} alt="" loading="lazy" />
                  {:else}
                    <span>♫</span>
                  {/if}
                </span>
                <span class="album-copy">
                  <strong>{album.name}</strong>
                  <small>{album.year ?? 'Unknown year'} · {album.tracks.length} tracks</small>
                </span>
              </a>
              <button type="button" class="row-action" onclick={() => playAlbum(selectedArtist!, album)}>▶</button>
              <button type="button" class="row-action" onclick={() => addAlbumToQueue(selectedArtist!, album)}>＋</button>
            </article>
          {:else}
            <div class="empty-state"><p>No albums found.</p></div>
          {/each}
        </div>
      {:else if artists.length > 0}
        <div class="artist-grid">
          {#each artists as artist}
            <article class="artist-card">
              <a class="artist-main" href={artistRoute(artist)}>
                <span class="cover artist-cover">
                  {#if coverArtUrl(artistCoverArt(artist))}
                    <img src={coverArtUrl(artistCoverArt(artist))} alt="" loading="lazy" />
                  {:else}
                    <span>♫</span>
                  {/if}
                  <strong class="artist-name">{artist.name}</strong>
                </span>
              </a>
              <button type="button" class="artist-play" onclick={() => playArtist(artist)}>▶</button>
            </article>
          {/each}
        </div>
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
        <a class="primary" href="#/settings">Open settings</a>
      </div>
    {/if}
  </section>

  {#if queue.length > 0 && activeView !== 'player'}
    <a class="mini-player" href="#/player">
      <span class="mini-art">
        {#if coverArtUrl(queue[currentIndex >= 0 ? currentIndex : 0].coverArt)}
          <img src={coverArtUrl(queue[currentIndex >= 0 ? currentIndex : 0].coverArt)} alt="" />
        {:else}
          <span>♫</span>
        {/if}
      </span>
      <span class="mini-copy">
        <strong>{queue[currentIndex >= 0 ? currentIndex : 0].title}</strong>
        <small>{queue[currentIndex >= 0 ? currentIndex : 0].artist}</small>
      </span>
      <span
        class="mini-control"
        role="button"
        tabindex="0"
        onclick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          togglePlayback();
        }}
        onkeydown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') togglePlayback();
        }}>{isPlaying ? 'Ⅱ' : '▶'}</span
      >
      <span class="mini-progress"><span style:width={`${playbackPercent()}%`}></span></span>
    </a>
  {/if}

  <nav class="bottom-nav">
    <a class:active={activeView === 'library'} href="#/library">
      <span>♫</span><small>Library</small>
    </a>
    <a class:active={activeView === 'settings'} href="#/settings">
      <span>⚙</span><small>Settings</small>
    </a>
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

  a {
    color: inherit;
    text-decoration: none;
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

  .primary {
    display: inline-grid;
    width: fit-content;
    place-items: center;
    border-radius: 999px;
    font-size: 0.82rem;
    font-weight: 650;
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

  .player-main {
    display: flex;
    height: calc(100dvh - 6.75rem);
    min-height: 0;
    flex-direction: column;
    justify-content: center;
  }

  .artwork {
    display: grid;
    width: 100%;
    min-height: 0;
    margin: 0 0 1.5rem;
    overflow: hidden;
    flex: 1 1 auto;
    place-items: center;
    border-radius: 1.5rem;
    color: rgb(255 255 255 / 85%);
    background: linear-gradient(145deg, #7665f6, #d35b91);
    box-shadow: 0 1.5rem 3.5rem rgb(0 0 0 / 38%);
    font-size: 5rem;
  }

  .artwork img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  .player-main > p {
    flex: none;
    margin-bottom: 1.4rem;
    text-align: center;
  }

  .player-main > p strong {
    font-size: 1.25rem;
  }

  .playback-progress {
    flex: none;
    margin: 1.5rem 0 1.25rem;
  }

  .playback-slider {
    width: 100%;
    margin: 0;
    accent-color: #8d7dff;
  }

  .playback-time {
    display: flex;
    justify-content: space-between;
    margin-top: 0.45rem;
    color: #8f96a5;
    font-size: 0.72rem;
    font-variant-numeric: tabular-nums;
  }

  .controls {
    display: flex;
    flex: none;
    align-items: center;
    justify-content: center;
    gap: 0.75rem;
  }

  .controls button {
    display: grid;
    width: 3.2rem;
    height: 3.2rem;
    padding: 0;
    place-items: center;
    font-size: 1.25rem;
  }

  .controls .play-control {
    width: 4.2rem;
    height: 4.2rem;
    background: #7565f6;
    font-size: 1.45rem;
  }

  .back-button {
    display: inline-block;
    margin-bottom: 1rem;
    padding: 0.5rem 0.75rem;
    color: #bcb4ff;
    background: transparent;
  }

  .artist-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 0.8rem;
  }

  .artist-card {
    position: relative;
    min-width: 0;
    overflow: hidden;
    border: 1px solid #272c38;
    border-radius: 0;
    background: #171b23;
  }

  .artist-main,
  .album-main,
  .track-main {
    border-radius: 0;
    color: inherit;
    background: transparent;
    text-align: left;
  }

  .artist-main {
    display: grid;
    width: 100%;
    padding: 0;
  }

  .cover {
    position: relative;
    display: grid;
    overflow: hidden;
    flex: none;
    place-items: center;
    color: #bcb4ff;
    background: linear-gradient(145deg, #292845, #44293d);
  }

  .cover img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  .artist-cover {
    width: 100%;
    aspect-ratio: 1;
    font-size: 2.2rem;
  }

  .artist-cover::after {
    position: absolute;
    inset: 35% 0 0;
    content: '';
    background: linear-gradient(transparent, rgb(4 5 8 / 92%));
  }

  .artist-name {
    position: absolute;
    z-index: 1;
    right: 0.7rem;
    bottom: 0.65rem;
    left: 0.7rem;
    overflow: hidden;
    color: white;
    font-size: 0.9rem;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .artist-play {
    position: absolute;
    z-index: 2;
    top: 0.55rem;
    right: 0.55rem;
    display: grid;
    width: 2.2rem;
    height: 2.2rem;
    padding: 0;
    place-items: center;
    border: 1px solid rgb(255 255 255 / 25%);
    background: rgb(8 10 15 / 72%);
    backdrop-filter: blur(8px);
  }

  .album-list,
  .track-list {
    display: grid;
  }

  .album-row,
  .track-row {
    display: flex;
    min-width: 0;
    align-items: center;
    border-bottom: 1px solid #272c38;
  }

  .album-main {
    display: flex;
    min-width: 0;
    flex: 1;
    padding: 0.65rem 0;
    align-items: center;
    gap: 0.75rem;
  }

  .album-cover {
    width: 3.8rem;
    height: 3.8rem;
    border-radius: 0.55rem;
  }

  .album-copy {
    display: grid;
    min-width: 0;
  }

  .album-copy strong,
  .album-copy small {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .track-main {
    display: flex;
    min-width: 0;
    min-height: 3.5rem;
    flex: 1;
    padding: 0.65rem 0;
    align-items: center;
    gap: 0.75rem;
  }

  .track-main > span:last-child {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .track-number {
    width: 1.5rem;
    flex: none;
    color: #737b8b;
    text-align: right;
  }

  .row-action {
    width: 2.35rem;
    height: 2.35rem;
    flex: none;
    padding: 0;
    color: #bcb4ff;
    background: transparent;
    font-size: 1rem;
  }

  .player-queue {
    margin-top: 5.5rem;
    padding-top: 1.25rem;
    border-top: 1px solid #272c38;
  }

  .player-queue .track-row.current {
    background: #19182a;
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
    overflow: hidden;
    flex: none;
    place-items: center;
    border-radius: 0.65rem;
    background: linear-gradient(145deg, #7665f6, #d35b91);
  }

  .mini-art img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  .mini-progress {
    position: absolute;
    right: 0.5rem;
    bottom: 0;
    left: 0.5rem;
    overflow: hidden;
    height: 0.18rem;
    border-radius: 999px;
    background: #343a48;
  }

  .mini-progress span {
    display: block;
    height: 100%;
    background: #8d7dff;
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
    padding: 0 0 env(safe-area-inset-bottom);
    grid-template-columns: repeat(2, minmax(0, 1fr));
    border-top: 1px solid #292f3b;
    background: rgb(17 20 27 / 97%);
    backdrop-filter: blur(14px);
  }

  .bottom-nav a {
    display: grid;
    width: 100%;
    min-height: 4.25rem;
    gap: 0.15rem;
    place-items: center;
    border-radius: 0;
    color: #8f96a5;
    background: transparent;
    font-size: 1.05rem;
  }

  .bottom-nav a.active {
    color: #bcb4ff;
    background: #222332;
  }

  .bottom-nav small {
    color: inherit;
    font-size: 0.65rem;
  }
</style>
