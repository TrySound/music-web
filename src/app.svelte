<script lang="ts">
  import { md5 } from 'js-md5';
  import { onMount } from 'svelte';
  import { cacheImage, getCachedImage } from './image-cache';
  import { loadLibraryCache, saveLibraryCache } from './library-cache';
  import { cacheTrack, getCachedTrack } from './track-cache';

  const authStorageKey = 'navidrome-auth';
  const offlineModeStorageKey = 'navidrome-offline-mode';

  interface Track {
    album?: string;
    artist?: string;
    contentType?: string;
    coverArt?: string;
    genre?: string;
    genres?: { name: string }[];
    discNumber?: number;
    id: string;
    title: string;
    track?: number;
  }

  interface QueueItem {
    album: string;
    artist: string;
    contentType?: string;
    coverArt?: string;
    id: string;
    title: string;
  }

  interface Album {
    artist?: string;
    genre?: string;
    genres?: { name: string }[];
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
    genre?: string;
    genres?: { name: string }[];
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
    playQueue?: {
      current?: string;
      entry?: Track[];
      position?: number;
    };
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
  type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

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
  let playbackLoading = false;
  let playbackError = '';
  let audio: HTMLAudioElement;
  let pendingSeek = 0;
  let loadedQueueKey = '';
  let queueSaveTimer: ReturnType<typeof setTimeout> | undefined;
  let lastPositionSync = 0;
  let playbackObjectUrl = '';
  let playbackRequest = 0;
  let downloadingTrackIds = new Set<string>();
  let downloadedTrackIds = new Set<string>();
  let downloadedCacheKey = '';
  let downloadingCollection = '';
  let offlineMode = false;
  let offlineScanning = false;
  let coverArtObjectUrls = new Map<string, string>();
  let loading = false;
  let refreshing = false;
  let refreshError = '';
  let error = '';
  let connectedHost = '';
  let connectionStatus: ConnectionStatus = 'disconnected';
  let connectionOpen = false;

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

    if (selectedArtist) {
      void refreshDownloadedState(
        selectedAlbum
          ? albumQueueItems(selectedArtist, selectedAlbum)
          : artistQueueItems(selectedArtist)
      );
    }
  }

  function navigateTo(hash: string, history: 'push' | 'replace' = 'push') {
    void window.navigation.navigate(hash, { history }).finished?.catch(() => {});
  }

  function goBack() {
    if (window.navigation.canGoBack) {
      void window.navigation.back().finished?.catch(() => {});
    } else {
      navigateTo('#/library', 'replace');
    }
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
    offlineMode = localStorage.getItem(offlineModeStorageKey) === 'true';

    try {
      const value = localStorage.getItem(authStorageKey);
      if (!value) {
        connectionOpen = true;
        navigateTo('#/settings', 'replace');
        return;
      }

      const savedAuth: unknown = JSON.parse(value);
      if (!isSavedAuth(savedAuth)) {
        localStorage.removeItem(authStorageKey);
        connectionOpen = true;
        navigateTo('#/settings', 'replace');
        return;
      }

      activeAuth = savedAuth;
      host = savedAuth.host;
      username = savedAuth.username;
      void loadArtists(savedAuth);
    } catch {
      localStorage.removeItem(authStorageKey);
      connectionOpen = true;
      navigateTo('#/settings', 'replace');
    }
  });

  onMount(() => {
    const saveWhenHidden = () => {
      if (document.visibilityState === 'hidden') void saveServerQueue();
    };

    document.addEventListener('visibilitychange', saveWhenHidden);
    return () => document.removeEventListener('visibilitychange', saveWhenHidden);
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

  function coverArtCacheKey(id: string) {
    if (!activeAuth) return id;
    return `${activeAuth.host}\n${activeAuth.username}\n${id}`;
  }

  function coverArtSource(id?: string) {
    if (!id) return '';
    return coverArtObjectUrls.get(id) ?? (offlineMode ? '' : coverArtUrl(id));
  }

  function installCachedCoverArt(id: string, file: File, type: string) {
    if (coverArtObjectUrls.has(id)) return;

    const url = URL.createObjectURL(new Blob([file], { type }));
    coverArtObjectUrls = new Map(coverArtObjectUrls).set(id, url);
  }

  async function ensureCoverArtCached(id?: string) {
    if (!id || !activeAuth || coverArtObjectUrls.has(id)) return;

    const cached = await cacheImage(coverArtCacheKey(id), coverArtUrl(id));
    installCachedCoverArt(id, cached.file, cached.type);
  }

  async function loadCachedCoverArt(id?: string) {
    if (!id || !activeAuth || coverArtObjectUrls.has(id)) return;

    const cached = await getCachedImage(coverArtCacheKey(id));
    if (cached) installCachedCoverArt(id, cached.file, cached.type);
  }

  function clearCoverArtObjectUrls() {
    for (const url of coverArtObjectUrls.values()) URL.revokeObjectURL(url);
    coverArtObjectUrls = new Map();
  }

  function artistCoverArt(artist: Artist) {
    return artist.coverArt ?? artist.albums.find((album) => album.coverArt)?.coverArt;
  }

  function displayedArtistCoverArt(artist: Artist) {
    if (!offlineMode) return artistCoverArt(artist);
    return [
      artist.coverArt,
      ...artist.albums.flatMap((album) => [album.coverArt, ...album.tracks.map((track) => track.coverArt)])
    ].find((id) => id && coverArtObjectUrls.has(id));
  }

  function displayedAlbumCoverArt(album: Album) {
    if (!offlineMode) return album.coverArt;
    return [album.coverArt, ...album.tracks.map((track) => track.coverArt)]
      .find((id) => id && coverArtObjectUrls.has(id));
  }

  function directGenres(item: { genre?: string; genres?: { name: string }[] }) {
    const genres = [...(item.genres?.map((genre) => genre.name) ?? []), ...(item.genre ? [item.genre] : [])];
    return genres.flatMap((genre) => genre.split('|')).map((genre) => genre.trim()).filter(Boolean);
  }

  function uniqueGenres(genres: string[]) {
    return [...new Map(genres.map((genre) => [genre.toLocaleLowerCase(), genre])).values()]
      .sort((a, b) => a.localeCompare(b));
  }

  function albumGenres(album: Album) {
    return uniqueGenres([...directGenres(album), ...album.tracks.flatMap(directGenres)]);
  }

  function artistGenres(artist: Artist) {
    return uniqueGenres([...directGenres(artist), ...artist.albums.flatMap(albumGenres)]);
  }

  function albumQueueItems(artist: Artist, album: Album): QueueItem[] {
    return album.tracks.map((track) => ({
      album: album.name,
      artist: artist.name,
      contentType: track.contentType,
      coverArt: track.coverArt ?? album.coverArt ?? artistCoverArt(artist),
      id: track.id,
      title: track.title
    }));
  }

  function artistQueueItems(artist: Artist): QueueItem[] {
    return artist.albums.flatMap((album) => albumQueueItems(artist, album));
  }

  function visibleTracks(album: Album) {
    return offlineMode
      ? album.tracks.filter((track) => downloadedTrackIds.has(track.id))
      : album.tracks;
  }

  function visibleAlbums(artist: Artist) {
    return offlineMode
      ? artist.albums.filter((album) => visibleTracks(album).length > 0)
      : artist.albums;
  }

  function visibleArtists() {
    return offlineMode
      ? artists.filter((artist) => visibleAlbums(artist).length > 0)
      : artists;
  }

  function availableQueueItems(items: QueueItem[]) {
    return offlineMode ? items.filter((track) => downloadedTrackIds.has(track.id)) : items;
  }

  function trackQueueItem(artist: Artist, album: Album, track: Track): QueueItem {
    return {
      album: album.name,
      artist: artist.name,
      contentType: track.contentType,
      coverArt: track.coverArt ?? album.coverArt ?? artistCoverArt(artist),
      id: track.id,
      title: track.title
    };
  }

  function playAlbum(artist: Artist, album: Album) {
    replaceQueueAndPlay(availableQueueItems(albumQueueItems(artist, album)));
  }

  function addAlbumToQueue(artist: Artist, album: Album) {
    queue = [...queue, ...availableQueueItems(albumQueueItems(artist, album))];
    scheduleQueueSave();
  }

  function playArtist(artist: Artist) {
    replaceQueueAndPlay(availableQueueItems(artistQueueItems(artist)));
  }

  function playTrack(artist: Artist, album: Album, track: Track) {
    const albumTracks = availableQueueItems(albumQueueItems(artist, album));
    const selectedIndex = albumTracks.findIndex((item) => item.id === track.id);
    replaceQueueAndPlay(albumTracks, Math.max(0, selectedIndex));
  }

  function addTrackToQueue(artist: Artist, album: Album, track: Track) {
    if (offlineMode && !downloadedTrackIds.has(track.id)) return;
    queue = [...queue, trackQueueItem(artist, album, track)];
    scheduleQueueSave();
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

  function trackCacheKey(track: QueueItem) {
    if (!activeAuth) return track.id;
    return `${activeAuth.host}\n${activeAuth.username}\n${track.id}`;
  }

  function updateTrackSet(set: Set<string>, trackId: string, add: boolean) {
    const next = new Set(set);
    if (add) next.add(trackId);
    else next.delete(trackId);
    return next;
  }

  async function ensureTrackCached(track: QueueItem) {
    const source = streamUrl(track);
    if (!source) throw new Error('No active Navidrome connection.');

    downloadingTrackIds = updateTrackSet(downloadingTrackIds, track.id, true);
    try {
      const key = trackCacheKey(track);
      const trackFile = getCachedTrack(key).then((cached) => cached ?? cacheTrack(key, source));
      const [file] = await Promise.all([
        trackFile,
        ensureCoverArtCached(track.coverArt).catch(() => {})
      ]);
      downloadedTrackIds = updateTrackSet(downloadedTrackIds, track.id, true);
      return file;
    } finally {
      downloadingTrackIds = updateTrackSet(downloadingTrackIds, track.id, false);
    }
  }

  async function downloadQueueTrack(track: QueueItem) {
    try {
      await ensureTrackCached(track);
    } catch (caught) {
      playbackError = caught instanceof Error ? caught.message : 'The track could not be downloaded.';
    }
  }

  async function downloadTracks(items: QueueItem[]) {
    let nextTrack = 0;

    async function worker() {
      while (nextTrack < items.length) {
        const track = items[nextTrack++];
        await downloadQueueTrack(track);
      }
    }

    await Promise.all(Array.from({ length: Math.min(3, items.length) }, () => worker()));
  }

  async function downloadAlbum(artist: Artist, album: Album) {
    const key = `album:${album.id}`;
    downloadingCollection = key;
    try {
      await downloadTracks(albumQueueItems(artist, album));
    } finally {
      if (downloadingCollection === key) downloadingCollection = '';
    }
  }

  async function downloadArtist(artist: Artist) {
    const key = `artist:${artist.id ?? artist.name}`;
    downloadingCollection = key;
    try {
      await downloadTracks(artistQueueItems(artist));
    } finally {
      if (downloadingCollection === key) downloadingCollection = '';
    }
  }

  function downloadLibraryTrack(artist: Artist, album: Album, track: Track) {
    void downloadQueueTrack(trackQueueItem(artist, album, track));
  }

  async function refreshDownloadedState(items: QueueItem[]) {
    if (!activeAuth) return;

    let nextTrack = 0;
    const cachedIds: string[] = [];

    async function worker() {
      while (nextTrack < items.length) {
        const track = items[nextTrack++];
        try {
          if (await getCachedTrack(trackCacheKey(track))) cachedIds.push(track.id);
        } catch {
          return;
        }
      }
    }

    await Promise.all(Array.from({ length: Math.min(8, items.length) }, () => worker()));
    if (cachedIds.length > 0) {
      downloadedTrackIds = new Set([...downloadedTrackIds, ...cachedIds]);
    }
  }

  async function scanOfflineLibrary() {
    if (!activeAuth) return;

    offlineScanning = true;
    try {
      const cacheKey = `${activeAuth.host}\n${activeAuth.username}`;
      if (downloadedCacheKey !== cacheKey) {
        downloadedTrackIds = new Set();
        clearCoverArtObjectUrls();
        downloadedCacheKey = cacheKey;
      }

      const libraryTracks = artists.flatMap(artistQueueItems);
      await refreshDownloadedState(libraryTracks);

      const coverArtIds = [
        ...new Set(
          libraryTracks
            .filter((track) => downloadedTrackIds.has(track.id))
            .map((track) => track.coverArt)
            .filter((id): id is string => Boolean(id))
        )
      ];
      await Promise.all(coverArtIds.map(loadCachedCoverArt));

      const currentTrackId = queue[currentIndex]?.id;
      const offlineQueue = queue.filter((track) => downloadedTrackIds.has(track.id));
      const offlineIndex = currentTrackId
        ? offlineQueue.findIndex((track) => track.id === currentTrackId)
        : -1;

      if (currentTrackId && offlineIndex < 0) stopPlayback();
      queue = offlineQueue;
      currentIndex = offlineIndex;
      syncCurrentRoute();
    } finally {
      offlineScanning = false;
    }
  }

  async function setOfflineMode(enabled: boolean) {
    offlineMode = enabled;
    localStorage.setItem(offlineModeStorageKey, String(enabled));

    if (enabled) await scanOfflineLibrary();
    else if (activeAuth) {
      loadedQueueKey = '';
      void loadArtists(activeAuth);
    }
  }

  function collectionIsDownloaded(items: QueueItem[]) {
    return items.length > 0 && items.every((track) => downloadedTrackIds.has(track.id));
  }

  async function loadServerQueue(server: string, authQuery: URLSearchParams) {
    const response = await fetch(`${server}/rest/getPlayQueue.view?${authQuery}`);
    if (!response.ok) throw new Error(`The server returned HTTP ${response.status}.`);

    const body: SubsonicEnvelope = await response.json();
    const result = body['subsonic-response'];
    if (!result) throw new Error('The server returned an unexpected response.');
    if (result.status !== 'ok') {
      throw new Error(result.error?.message || 'Navidrome rejected the request.');
    }

    const playQueue = result.playQueue;
    queue = (playQueue?.entry ?? []).map((track) => ({
      album: track.album ?? 'Unknown album',
      artist: track.artist ?? 'Unknown artist',
      contentType: track.contentType,
      coverArt: track.coverArt,
      id: track.id,
      title: track.title
    }));
    currentIndex = playQueue?.current
      ? queue.findIndex((track) => track.id === playQueue.current)
      : -1;
    void refreshDownloadedState(queue);

    if (currentIndex >= 0) pendingSeek = (playQueue?.position ?? 0) / 1000;
  }

  async function saveServerQueue() {
    if (!activeAuth || offlineMode) return;

    const query = new URLSearchParams({
      u: activeAuth.username,
      t: activeAuth.token,
      s: activeAuth.salt,
      v: '1.16.1',
      c: 'navidrome-artists',
      f: 'json'
    });
    for (const track of queue) query.append('id', track.id);

    if (currentIndex >= 0 && queue[currentIndex]) {
      query.set('current', queue[currentIndex].id);
      query.set('position', String(Math.round(audio.currentTime * 1000)));
    }

    try {
      const response = await fetch(`${activeAuth.host}/rest/savePlayQueue.view`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: query,
        keepalive: true
      });
      if (!response.ok) throw new Error();

      const body: SubsonicEnvelope = await response.json();
      if (body['subsonic-response']?.status !== 'ok') throw new Error();
    } catch {
      playbackError = 'The queue could not be synchronized with Navidrome.';
    }
  }

  function scheduleQueueSave() {
    clearTimeout(queueSaveTimer);
    queueSaveTimer = setTimeout(() => void saveServerQueue(), 300);
  }

  function updatePlaybackTime() {
    currentTime = audio.currentTime;
    if (Date.now() - lastPositionSync >= 10_000) {
      lastPositionSync = Date.now();
      void saveServerQueue();
    }
  }

  function replaceQueueAndPlay(items: QueueItem[], startIndex = 0) {
    queue = items;
    currentIndex = items.length > 0 ? Math.min(startIndex, items.length - 1) : -1;
    pendingSeek = 0;
    scheduleQueueSave();
    if (currentIndex >= 0) void playCurrent();
    else stopPlayback();
  }

  async function playCurrent() {
    const track = queue[currentIndex];
    if (!track) return;

    const request = ++playbackRequest;
    playbackError = '';
    playbackLoading = true;
    currentTime = 0;
    duration = 0;
    scheduleQueueSave();

    try {
      const file = await ensureTrackCached(track);
      if (request !== playbackRequest) return;
      if (playbackObjectUrl) URL.revokeObjectURL(playbackObjectUrl);
      const playableFile = track.contentType ? new Blob([file], { type: track.contentType }) : file;
      playbackObjectUrl = URL.createObjectURL(playableFile);
      audio.src = playbackObjectUrl;
      await audio.play();
    } catch (caught) {
      playbackLoading = false;
      playbackError = caught instanceof Error ? caught.message : 'Playback failed.';
    }
  }

  function stopPlayback() {
    playbackRequest += 1;
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
    if (playbackObjectUrl) URL.revokeObjectURL(playbackObjectUrl);
    playbackObjectUrl = '';
    currentIndex = -1;
    currentTime = 0;
    duration = 0;
    isPlaying = false;
    playbackLoading = false;
  }

  function clearQueue() {
    stopPlayback();
    queue = [];
    scheduleQueueSave();
  }

  function togglePlayback() {
    if (audio.paused) {
      if (currentIndex < 0 && queue.length > 0) {
        currentIndex = 0;
        pendingSeek = 0;
        void playCurrent();
      } else if (!audio.currentSrc) {
        void playCurrent();
      } else {
        void audio.play().catch((caught: unknown) => {
          playbackError = caught instanceof Error ? caught.message : 'Playback failed.';
        });
      }
    } else {
      audio.pause();
      playbackLoading = false;
      void saveServerQueue();
    }
  }

  function playQueueIndex(index: number) {
    currentIndex = index;
    pendingSeek = 0;
    void playCurrent();
  }

  function nextTrack() {
    if (currentIndex + 1 >= queue.length) {
      audio.pause();
      isPlaying = false;
      playbackLoading = false;
      void saveServerQueue();
      return;
    }
    currentIndex += 1;
    pendingSeek = 0;
    void playCurrent();
  }

  function previousTrack() {
    if (audio.currentTime > 3 || currentIndex <= 0) {
      audio.currentTime = 0;
      scheduleQueueSave();
      return;
    }
    currentIndex -= 1;
    pendingSeek = 0;
    void playCurrent();
  }

  function seek(value: number) {
    if (Number.isFinite(value)) {
      audio.currentTime = value;
      scheduleQueueSave();
    }
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

  function connectionStatusLabel() {
    if (offlineMode) return 'Offline mode';
    if (connectionStatus === 'connected') return 'Connected';
    if (connectionStatus === 'connecting') return 'Checking…';
    if (connectionStatus === 'error') return 'Connection failed';
    return 'Disconnected';
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
    if (!error) {
      connectionOpen = false;
      navigateTo('#/library');
    }
  }

  async function loadArtists(savedAuth?: SavedAuth, forceRefresh = false) {
    loading = true;
    connectionStatus = 'connecting';
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

      if (offlineMode) {
        activeAuth = credentials;
        connectionStatus = 'disconnected';
        if (!cached) throw new Error('No cached library is available offline.');
        await scanOfflineLibrary();
        return;
      }

      const lastModified = await getLastModified(server, query, cached?.lastModified);
      activeAuth = credentials;
      connectionStatus = 'connected';
      localStorage.setItem(authStorageKey, JSON.stringify(credentials));

      if (loadedQueueKey !== cacheKey) {
        downloadedTrackIds = new Set();
        clearCoverArtObjectUrls();
        downloadedCacheKey = cacheKey;
        try {
          await loadServerQueue(server, query);
          loadedQueueKey = cacheKey;
        } catch {
          playbackError = 'The saved Navidrome queue could not be loaded.';
        }
      }

      if (!forceRefresh && cached && lastModified === cached.lastModified) return;

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
      connectionStatus = 'error';
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

{#snippet soundBars()}
  <span class="sound-bars"><span></span><span></span><span></span></span>
{/snippet}

{#snippet loadingSpinner()}
  <span class="loading-spinner"></span>
{/snippet}

<main class="app-shell">
  <header class="topbar">
    {#if activeView === 'library' && selectedArtist}
      <a
        class="topbar-icon"
        href={selectedAlbum ? artistRoute(selectedArtist) : '#/library'}
        title="Back"
      >‹</a>
    {:else if activeView === 'player'}
      <button type="button" class="topbar-icon" onclick={goBack} title="Back">‹</button>
    {:else}
      <span class="topbar-spacer"></span>
    {/if}

    <strong>
      {activeView === 'player'
        ? 'Now playing'
        : activeView === 'settings'
          ? 'Settings'
          : 'Library'}
    </strong>

    {#if activeView === 'library' && !selectedArtist}
      <a class="topbar-icon" href="#/settings" title="Settings">⚙</a>
    {:else}
      <a class="topbar-icon" href="#/library" title="Home">⌂</a>
    {/if}
  </header>

  <section class="view settings-view" class:hidden={activeView !== 'settings'}>
    <span class="eyebrow">Settings</span>
    <h2>{activeAuth ? 'Music server' : 'Connect to your music'}</h2>
    <p class="muted">
      {activeAuth
        ? 'Manage the server used for your library.'
        : 'Enter your Navidrome server details. Authentication stays on this device.'}
    </p>

    <details class="connection-card" bind:open={connectionOpen}>
      <summary>
        <span
          class="connection-dot"
          class:offline={offlineMode}
          class:connected={!offlineMode && connectionStatus === 'connected'}
          class:connecting={!offlineMode && connectionStatus === 'connecting'}
          class:failed={!offlineMode && connectionStatus === 'error'}
        ></span>
        <span class="connection-summary">
          <strong>{activeAuth?.host ?? 'Add a server'}</strong>
          <small>
            {activeAuth ? `${activeAuth.username} · ${connectionStatusLabel()}` : 'Navidrome connection'}
          </small>
        </span>
        <span class="connection-chevron">⌄</span>
      </summary>

      <div class="connection-details">
        {#if activeAuth}
          <div class="connection-status">
            <span>Status</span>
            <strong>{connectionStatusLabel()}</strong>
          </div>
          <button
            type="button"
            class="refresh-data"
            disabled={offlineMode || loading || refreshing}
            onclick={() => loadArtists(activeAuth!, true)}
          >
            {offlineMode ? 'Unavailable offline' : loading || refreshing ? 'Refreshing…' : 'Refresh library data'}
          </button>
          <h3>Edit connection</h3>
        {/if}

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

          <button type="submit" disabled={offlineMode || loading || refreshing}>
            {loading ? 'Connecting…' : activeAuth ? 'Save connection' : 'Connect'}
          </button>

          <small>Authentication is saved in this browser after a successful login.</small>
        </form>
      </div>
    </details>

    <div class="settings-option">
      <div>
        <strong>Offline library</strong>
        <small>
          {offlineScanning
            ? 'Checking downloaded tracks…'
            : 'Show only music downloaded to this device.'}
        </small>
      </div>
      <label class="switch">
        <input
          type="checkbox"
          checked={offlineMode}
          disabled={offlineScanning}
          onchange={(event) => void setOfflineMode(event.currentTarget.checked)}
        />
        <span></span>
      </label>
    </div>
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
      {#if currentIndex >= 0 && queue[currentIndex] && coverArtSource(queue[currentIndex].coverArt)}
        <img src={coverArtSource(queue[currentIndex].coverArt)} alt="" />
      {:else}
        <span>♫</span>
      {/if}
    </div>
    <audio
      bind:this={audio}
      preload="metadata"
      onplay={() => isPlaying = true}
      onplaying={() => {
        isPlaying = true;
        playbackLoading = false;
      }}
      onpause={() => isPlaying = false}
      onwaiting={() => playbackLoading = true}
      oncanplay={() => playbackLoading = false}
      onended={nextTrack}
      ontimeupdate={updatePlaybackTime}
      onloadedmetadata={() => {
        duration = audio.duration;
        if (pendingSeek > 0) {
          audio.currentTime = Math.min(pendingSeek, duration || pendingSeek);
          currentTime = audio.currentTime;
          pendingSeek = 0;
        }
      }}
      onerror={() => {
        playbackLoading = false;
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
        {#if playbackLoading}{@render loadingSpinner()}{:else}{isPlaying ? 'Ⅱ' : '▶'}{/if}
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
                <span class="track-number">{index + 1}</span>
                <span>{item.title}</span>
              </button>
              <button
                type="button"
                class="row-action"
                onclick={() => downloadQueueTrack(item)}
                title="Download track"
              >
                {#if downloadingTrackIds.has(item.id) || (index === currentIndex && playbackLoading)}
                  {@render loadingSpinner()}
                {:else if index === currentIndex && isPlaying}
                  {@render soundBars()}
                {:else if downloadedTrackIds.has(item.id)}
                  ✓
                {:else}
                  ↓
                {/if}
              </button>
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
      <div class="section-heading">
        <div>
          <span class="eyebrow">
            {selectedAlbum ? selectedArtist?.name : selectedArtist ? 'Albums' : offlineMode ? 'Downloaded music' : 'Your music'}
          </span>
          <h2>{selectedAlbum?.name ?? selectedArtist?.name ?? `${visibleArtists().length} artists`}</h2>
          {#if selectedAlbum}
            <p class="library-meta">
              {selectedArtist?.name} · {selectedAlbum.year ?? 'Unknown year'} · {visibleTracks(selectedAlbum).length} track{visibleTracks(selectedAlbum).length === 1 ? '' : 's'}
            </p>
            {#if albumGenres(selectedAlbum).length > 0}
              <div class="genre-list">
                {#each albumGenres(selectedAlbum) as genre}<span>{genre}</span>{/each}
              </div>
            {/if}
          {:else if selectedArtist}
            <p class="library-meta">
              {visibleAlbums(selectedArtist).length} album{visibleAlbums(selectedArtist).length === 1 ? '' : 's'}
            </p>
            {#if artistGenres(selectedArtist).length > 0}
              <div class="genre-list">
                {#each artistGenres(selectedArtist) as genre}<span>{genre}</span>{/each}
              </div>
            {/if}
          {/if}
        </div>
        {#if !offlineMode && selectedArtist && selectedAlbum}
          <button
            type="button"
            class="header-download"
            onclick={() => downloadAlbum(selectedArtist!, selectedAlbum!)}
            title="Download album"
          >
            {#if downloadingCollection === `album:${selectedAlbum.id}`}
              {@render loadingSpinner()}
            {:else if collectionIsDownloaded(albumQueueItems(selectedArtist, selectedAlbum))}
              ✓
            {:else}
              ↓
            {/if}
          </button>
        {:else if !offlineMode && selectedArtist}
          <button
            type="button"
            class="header-download"
            onclick={() => downloadArtist(selectedArtist!)}
            title="Download artist"
          >
            {#if downloadingCollection === `artist:${selectedArtist.id ?? selectedArtist.name}`}
              {@render loadingSpinner()}
            {:else if collectionIsDownloaded(artistQueueItems(selectedArtist))}
              ✓
            {:else}
              ↓
            {/if}
          </button>
        {/if}
      </div>

      {#if offlineScanning}
        <div class="empty-state">
          <div class="scan-spinner">{@render loadingSpinner()}</div>
          <p>Checking downloaded music…</p>
        </div>
      {:else if selectedArtist && selectedAlbum}
        <div class="track-list">
          {#each visibleTracks(selectedAlbum) as track, index}
            <div class="track-row">
              <button type="button" class="track-main" onclick={() => playTrack(selectedArtist!, selectedAlbum!, track)}>
                <span class="track-number">{track.track ?? index + 1}</span>
                <span>{track.title}</span>
              </button>
              <button
                type="button"
                class="row-action"
                onclick={() => downloadLibraryTrack(selectedArtist!, selectedAlbum!, track)}
                title="Download track"
              >
                {#if downloadingTrackIds.has(track.id) || (queue[currentIndex]?.id === track.id && playbackLoading)}
                  {@render loadingSpinner()}
                {:else if queue[currentIndex]?.id === track.id && isPlaying}
                  {@render soundBars()}
                {:else if downloadedTrackIds.has(track.id)}
                  ✓
                {:else}
                  ↓
                {/if}
              </button>
              <button type="button" class="row-action" onclick={() => addTrackToQueue(selectedArtist!, selectedAlbum!, track)}>＋</button>
            </div>
          {:else}
            <div class="empty-state"><p>{offlineMode ? 'No downloaded tracks.' : 'No tracks found.'}</p></div>
          {/each}
        </div>
      {:else if selectedArtist}
        <div class="album-list">
          {#each visibleAlbums(selectedArtist) as album}
            <article class="album-row">
              <a class="album-main" href={albumRoute(selectedArtist, album)}>
                <span class="cover album-cover">
                  {#if coverArtSource(displayedAlbumCoverArt(album))}
                    <img src={coverArtSource(displayedAlbumCoverArt(album))} alt="" loading="lazy" />
                  {:else}
                    <span>♫</span>
                  {/if}
                </span>
                <span class="album-copy">
                  <strong>{album.name}</strong>
                  <small>{album.year ?? 'Unknown year'} · {visibleTracks(album).length} tracks</small>
                </span>
              </a>
              <button type="button" class="row-action" onclick={() => playAlbum(selectedArtist!, album)}>
                {#if queue[currentIndex]?.album === album.name && queue[currentIndex]?.artist === selectedArtist.name && playbackLoading}
                  {@render loadingSpinner()}
                {:else if queue[currentIndex]?.album === album.name && queue[currentIndex]?.artist === selectedArtist.name && isPlaying}
                  {@render soundBars()}
                {:else}
                  ▶
                {/if}
              </button>
              <button type="button" class="row-action" onclick={() => addAlbumToQueue(selectedArtist!, album)}>＋</button>
            </article>
          {:else}
            <div class="empty-state"><p>{offlineMode ? 'No downloaded albums.' : 'No albums found.'}</p></div>
          {/each}
        </div>
      {:else if visibleArtists().length > 0}
        <div class="artist-grid">
          {#each visibleArtists() as artist}
            <article class="artist-card">
              <a class="artist-main" href={artistRoute(artist)}>
                <span class="cover artist-cover">
                  {#if coverArtSource(displayedArtistCoverArt(artist))}
                    <img src={coverArtSource(displayedArtistCoverArt(artist))} alt="" loading="lazy" />
                  {:else}
                    <span>♫</span>
                  {/if}
                  <strong class="artist-name">{artist.name}</strong>
                </span>
              </a>
              <button type="button" class="artist-play" onclick={() => playArtist(artist)}>
                {#if queue[currentIndex]?.artist === artist.name && playbackLoading}
                  {@render loadingSpinner()}
                {:else if queue[currentIndex]?.artist === artist.name && isPlaying}
                  {@render soundBars()}
                {:else}
                  ▶
                {/if}
              </button>
            </article>
          {/each}
        </div>
      {:else}
        <div class="empty-state">
          <span>♫</span>
          <p>{offlineMode ? 'No downloaded artists.' : 'No artists found.'}</p>
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
        {#if coverArtSource(queue[currentIndex >= 0 ? currentIndex : 0].coverArt)}
          <img src={coverArtSource(queue[currentIndex >= 0 ? currentIndex : 0].coverArt)} alt="" />
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
        }}>{#if playbackLoading}{@render loadingSpinner()}{:else}{isPlaying ? 'Ⅱ' : '▶'}{/if}</span
      >
      <span class="mini-progress"><span style:width={`${playbackPercent()}%`}></span></span>
    </a>
  {/if}

</main>
