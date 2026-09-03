import { createSubscriber } from "svelte/reactivity";
import {
  SubsonicClient,
  type SubsonicAlbum,
  type SubsonicArtist,
  type SubsonicTrack,
} from "./subsonic-client";

const databaseName = "navidrome-artists";
const storeName = "libraries";

export type Track = SubsonicTrack;
export type Album = SubsonicAlbum & { tracks: Track[] };
export type Artist = SubsonicArtist & { albums: Album[] };

export type MetadataStatus = "idle" | "loading" | "refreshing" | "ready" | "error";
export type MetadataNetwork = "offline" | "online";

interface LibraryRecord {
  data: Artist[];
  lastModified: number;
  savedAt: number;
}

export class MetadataEngine {
  #albums = new Map<string, Album>();
  #artists: Artist[] = [];
  #artistsById = new Map<string, Artist>();
  #client?: SubsonicClient;
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

  async #lastModified(client: SubsonicClient, cached?: number) {
    return (await client.getIndexes(cached)) ?? cached ?? null;
  }

  async #fetchAlbums(client: SubsonicClient) {
    const albums: SubsonicAlbum[] = [];
    const pageSize = 500;

    for (let offset = 0; ; offset += pageSize) {
      const page = await client.getAlbumList2({
        type: "alphabeticalByArtist",
        size: pageSize,
        offset,
      });
      albums.push(...page);
      if (page.length < pageSize) return albums;
    }
  }

  async #fetchTracks(client: SubsonicClient, albums: SubsonicAlbum[]) {
    const tracks = new Map<string, Track[]>();
    let nextAlbum = 0;

    const worker = async () => {
      while (nextAlbum < albums.length) {
        const album = albums[nextAlbum++];
        tracks.set(
          album.id,
          (await client.getAlbum(album.id)).sort(
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

  async #library(client: SubsonicClient) {
    const [artists, albums] = await Promise.all([client.getArtists(), this.#fetchAlbums(client)]);
    const tracks = await this.#fetchTracks(client, albums);
    const albumsByArtistId = new Map<string, Album[]>();
    const albumsByArtistName = new Map<string, Album[]>();

    for (const apiAlbum of albums) {
      const album = { ...apiAlbum, tracks: tracks.get(apiAlbum.id) ?? [] };
      const map = album.artistId ? albumsByArtistId : albumsByArtistName;
      const key = album.artistId ?? album.artist;
      if (!key) continue;
      map.set(key, [...(map.get(key) ?? []), album]);
    }

    return artists
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
    const client = this.#client;
    if (!client) return;

    const generation = ++this.#generation;
    const scope = `${client.host}\n${client.username}`;
    if (scope !== this.#scope) {
      this.#scope = scope;
      this.#publish([]);
    }
    this.#status = "loading";
    this.#error = undefined;
    this.#warning = undefined;
    this.#update();

    this.#resolve(client, scope, generation, forceRefresh).catch(() => {});
  }

  async #resolve(client: SubsonicClient, scope: string, generation: number, forceRefresh: boolean) {
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

      const lastModified = await this.#lastModified(client, existing?.lastModified);
      if (generation !== this.#generation) return;
      if (!forceRefresh && existing && lastModified === existing.lastModified) {
        this.#status = "ready";
        this.#update();
        return;
      }

      const artists = await this.#library(client);
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

  setClient(client: SubsonicClient) {
    if (client === this.#client) return;
    this.#client = client;
    this.#reload();
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
