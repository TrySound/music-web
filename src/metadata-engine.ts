import { createSubscriber } from "svelte/reactivity";

const databaseName = "navidrome-artists";
const storeName = "libraries";

export interface MetadataEngineAuth {
  host: string;
  username: string;
  token: string;
  salt: string;
}

export interface Track {
  album?: string;
  artist?: string;
  contentType?: string;
  coverArt?: string;
  discNumber?: number;
  genre?: string;
  genres?: { name: string }[];
  id: string;
  title: string;
  track?: number;
}

export interface Album {
  artist?: string;
  artistId?: string;
  coverArt?: string;
  genre?: string;
  genres?: { name: string }[];
  id: string;
  name: string;
  tracks: Track[];
  year?: number;
}

export interface Artist {
  albums: Album[];
  coverArt?: string;
  genre?: string;
  genres?: { name: string }[];
  id?: string;
  name: string;
}

export type MetadataStatus = "idle" | "loading" | "refreshing" | "ready" | "error";
export type MetadataNetwork = "offline" | "online";

type ApiAlbum = Omit<Album, "tracks">;
type ApiArtist = Omit<Artist, "albums">;

interface LibraryRecord {
  data: Artist[];
  lastModified: number;
  savedAt: number;
}

interface SubsonicResponse {
  status: string;
  error?: { message?: string };
  artists?: { index?: { artist?: ApiArtist[] }[] };
  albumList2?: { album?: ApiAlbum[] };
  album?: { song?: Track[] };
  indexes?: { lastModified?: number | string };
}

interface SubsonicEnvelope {
  "subsonic-response"?: SubsonicResponse;
}

export class MetadataEngine {
  #albums = new Map<string, Album>();
  #artists: Artist[] = [];
  #artistsById = new Map<string, Artist>();
  #auth?: MetadataEngineAuth;
  #error: unknown;
  #generation = 0;
  #network: MetadataNetwork = "online";
  #scope = "";
  #status: MetadataStatus = "idle";
  #tracks = new Map<string, Track>();
  #warning: unknown;
  #update = () => {};
  #subscribe = createSubscriber((update) => {
    this.#update = update;
    return () => {
      this.#update = () => {};
    };
  });

  getArtists(): readonly Artist[] {
    this.#subscribe();
    return this.#artists;
  }

  getArtist(id: string) {
    this.#subscribe();
    return this.#artistsById.get(id);
  }

  getAlbum(id: string) {
    this.#subscribe();
    return this.#albums.get(id);
  }

  getTrack(id: string) {
    this.#subscribe();
    return this.#tracks.get(id);
  }

  get status() {
    this.#subscribe();
    return this.#status;
  }

  get error() {
    this.#subscribe();
    return this.#error;
  }

  get warning() {
    this.#subscribe();
    return this.#warning;
  }

  #publish(artists: Artist[]) {
    this.#artists = artists;
    this.#artistsById.clear();
    this.#albums.clear();
    this.#tracks.clear();
    for (const artist of artists) {
      if (artist.id) this.#artistsById.set(artist.id, artist);
      this.#artistsById.set(artist.name, artist);
      for (const album of artist.albums) {
        this.#albums.set(album.id, album);
        for (const track of album.tracks) this.#tracks.set(track.id, track);
      }
    }
  }

  #authQuery(auth: MetadataEngineAuth) {
    return new URLSearchParams({
      u: auth.username,
      t: auth.token,
      s: auth.salt,
      v: "1.16.1",
      c: "navidrome-artists",
      f: "json",
    });
  }

  async #fetch(path: string, auth: MetadataEngineAuth, query = this.#authQuery(auth)) {
    const response = await fetch(`${auth.host}/rest/${path}.view?${query}`);
    if (!response.ok) throw new Error(`The server returned HTTP ${response.status}.`);

    const body: SubsonicEnvelope = await response.json();
    const result = body["subsonic-response"];
    if (!result) throw new Error("The server returned an unexpected response.");
    if (result.status !== "ok") {
      throw new Error(result.error?.message || "Navidrome rejected the request.");
    }
    return result;
  }

  async #lastModified(auth: MetadataEngineAuth, cached?: number) {
    const query = this.#authQuery(auth);
    if (cached !== undefined) query.set("ifModifiedSince", String(cached));
    const result = await this.#fetch("getIndexes", auth, query);
    if (!result.indexes) return cached ?? null;
    const value = Number(result.indexes.lastModified);
    return Number.isFinite(value) ? value : null;
  }

  async #fetchAlbums(auth: MetadataEngineAuth) {
    const albums: ApiAlbum[] = [];
    const pageSize = 500;

    for (let offset = 0; ; offset += pageSize) {
      const query = this.#authQuery(auth);
      query.set("type", "alphabeticalByArtist");
      query.set("size", String(pageSize));
      query.set("offset", String(offset));
      const result = await this.#fetch("getAlbumList2", auth, query);
      const page = result.albumList2?.album ?? [];
      albums.push(...page);
      if (page.length < pageSize) return albums;
    }
  }

  async #fetchTracks(auth: MetadataEngineAuth, albums: ApiAlbum[]) {
    const tracks = new Map<string, Track[]>();
    let nextAlbum = 0;

    const worker = async () => {
      while (nextAlbum < albums.length) {
        const album = albums[nextAlbum++];
        const query = this.#authQuery(auth);
        query.set("id", album.id);
        const result = await this.#fetch("getAlbum", auth, query);
        tracks.set(
          album.id,
          (result.album?.song ?? []).sort(
            (a, b) =>
              (a.discNumber ?? 1) - (b.discNumber ?? 1) ||
              (a.track ?? Number.MAX_SAFE_INTEGER) - (b.track ?? Number.MAX_SAFE_INTEGER) ||
              a.title.localeCompare(b.title),
          ),
        );
      }
    };

    await Promise.all(Array.from({ length: Math.min(6, albums.length) }, worker));
    return tracks;
  }

  async #library(auth: MetadataEngineAuth) {
    const [artistsResult, albums] = await Promise.all([
      this.#fetch("getArtists", auth),
      this.#fetchAlbums(auth),
    ]);
    const tracks = await this.#fetchTracks(auth, albums);
    const albumsByArtistId = new Map<string, Album[]>();
    const albumsByArtistName = new Map<string, Album[]>();

    for (const apiAlbum of albums) {
      const album = { ...apiAlbum, tracks: tracks.get(apiAlbum.id) ?? [] };
      const map = album.artistId ? albumsByArtistId : albumsByArtistName;
      const key = album.artistId ?? album.artist;
      if (!key) continue;
      map.set(key, [...(map.get(key) ?? []), album]);
    }

    return (artistsResult.artists?.index ?? [])
      .flatMap((index) => index.artist ?? [])
      .map((artist) => ({
        ...artist,
        albums:
          (artist.id ? albumsByArtistId.get(artist.id) : undefined) ??
          albumsByArtistName.get(artist.name) ??
          [],
      }))
      .map((artist) => ({
        ...artist,
        albums: artist.albums.sort(
          (a, b) =>
            (a.year ?? Number.MAX_SAFE_INTEGER) - (b.year ?? Number.MAX_SAFE_INTEGER) ||
            a.name.localeCompare(b.name),
        ),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async #database() {
    return new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(databaseName, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(storeName)) {
          request.result.createObjectStore(storeName);
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async #loadRecord(key: string) {
    const database = await this.#database();
    try {
      return await new Promise<LibraryRecord | null>((resolve, reject) => {
        const request = database.transaction(storeName).objectStore(storeName).get(key);
        request.onsuccess = () => resolve((request.result as LibraryRecord | undefined) ?? null);
        request.onerror = () => reject(request.error);
      });
    } finally {
      database.close();
    }
  }

  async #saveRecord(key: string, record: LibraryRecord) {
    const database = await this.#database();
    try {
      await new Promise<void>((resolve, reject) => {
        const transaction = database.transaction(storeName, "readwrite");
        transaction.objectStore(storeName).put(record, key);
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
      });
    } finally {
      database.close();
    }
  }

  #reload(forceRefresh = false) {
    const auth = this.#auth;
    if (!auth) return;

    const generation = ++this.#generation;
    const scope = `${auth.host}\n${auth.username}`;
    if (scope !== this.#scope) {
      this.#scope = scope;
      this.#publish([]);
    }
    this.#status = "loading";
    this.#error = undefined;
    this.#warning = undefined;
    this.#update();

    this.#resolve(auth, scope, generation, forceRefresh).catch(() => {});
  }

  async #resolve(
    auth: MetadataEngineAuth,
    scope: string,
    generation: number,
    forceRefresh: boolean,
  ) {
    let existing: LibraryRecord | null = null;
    try {
      existing = await this.#loadRecord(scope).catch(() => null);
      if (generation !== this.#generation) return;
      if (existing) {
        this.#publish(existing.data);
        this.#status = this.#network === "online" ? "refreshing" : "ready";
        this.#update();
      }

      if (this.#network === "offline") {
        if (!existing) throw new Error("No library is available offline.");
        return;
      }

      const lastModified = await this.#lastModified(auth, existing?.lastModified);
      if (generation !== this.#generation) return;
      if (!forceRefresh && existing && lastModified === existing.lastModified) {
        this.#status = "ready";
        this.#update();
        return;
      }

      const artists = await this.#library(auth);
      if (generation !== this.#generation) return;
      await this.#saveRecord(scope, {
        data: artists,
        lastModified: lastModified ?? 0,
        savedAt: Date.now(),
      });
      if (generation !== this.#generation) return;
      this.#publish(artists);
      this.#status = "ready";
      this.#update();
    } catch (error) {
      if (generation !== this.#generation) return;
      if (existing) {
        this.#status = "ready";
        this.#warning = error;
      } else {
        this.#status = "error";
        this.#error = error;
      }
      this.#update();
    }
  }

  refresh() {
    this.#reload(true);
  }

  setAuth(auth: MetadataEngineAuth) {
    const unchanged =
      this.#auth &&
      this.#auth.host === auth.host &&
      this.#auth.username === auth.username &&
      this.#auth.token === auth.token &&
      this.#auth.salt === auth.salt;
    this.#auth = auth;
    if (!unchanged) this.#reload();
  }

  setNetwork(network: MetadataNetwork) {
    if (network === this.#network) return;
    this.#network = network;
    this.#reload();
  }

  destroy() {
    this.#generation += 1;
  }
}
