import { createSubscriber } from "svelte/reactivity";

export interface TrackEngineAuth {
  host: string;
  username: string;
  token: string;
  salt: string;
}

export interface EngineTrack {
  id: string;
  contentType?: string;
}

export interface TrackSource {
  cached: boolean;
  url: string;
}

export interface TrackSourceOptions {
  forceTranscode?: boolean;
}

export type TrackStatus = "idle" | "downloading" | "downloaded";

export interface TrackEngineOptions {
  auth?: TrackEngineAuth;
}

interface StreamDescriptor {
  cacheKey: string;
  contentType: string;
  url: string;
}

interface TrackStore {
  get(key: string): Promise<File | null>;
  put(key: string, response: Response): Promise<File>;
}

export class TrackEngine {
  #activeObjectUrl = "";
  #auth?: TrackEngineAuth;
  #downloads = new Map<string, Promise<File>>();
  #statuses = new Map<string, TrackStatus>();
  #mediaProbe = document.createElement("audio");
  #sourceRequest = 0;
  #store: TrackStore;
  #update = () => {};
  #subscribe = createSubscriber((update) => {
    this.#update = update;
    return () => {
      this.#update = () => {};
    };
  });

  constructor(options: TrackEngineOptions = {}) {
    this.#auth = options.auth;
    this.#store = new OpfsTrackStore();
  }

  #clearObjectUrl() {
    if (!this.#activeObjectUrl) return;
    URL.revokeObjectURL(this.#activeObjectUrl);
    this.#activeObjectUrl = "";
  }

  #describe(track: EngineTrack, options: TrackSourceOptions = {}): StreamDescriptor {
    if (!this.#auth) throw new Error("No active Navidrome connection.");

    const format =
      !options.forceTranscode &&
      track.contentType &&
      this.#mediaProbe.canPlayType(track.contentType)
        ? "raw"
        : "mp3";
    const contentType = format === "raw" && track.contentType ? track.contentType : "audio/mpeg";
    const query = new URLSearchParams({
      id: track.id,
      u: this.#auth.username,
      t: this.#auth.token,
      s: this.#auth.salt,
      v: "1.16.1",
      c: "navidrome-artists",
      format,
      estimateContentLength: "true",
    });

    return {
      cacheKey: `${this.#auth.host}\n${this.#auth.username}\n${track.id}\n${format}-v1`,
      contentType,
      url: `${this.#auth.host}/rest/stream.view?${query}`,
    };
  }

  async #download(track: EngineTrack, descriptor: StreamDescriptor) {
    const cached = await this.#store.get(descriptor.cacheKey);
    if (cached) {
      this.#statuses.set(track.id, "downloaded");
      this.#update();
      return cached;
    }

    this.#statuses.set(track.id, "downloading");
    this.#update();
    try {
      const response = await fetch(descriptor.url);
      if (!response.ok) throw new Error(`The server returned HTTP ${response.status}.`);
      const file = await this.#store.put(descriptor.cacheKey, response);
      this.#statuses.set(track.id, "downloaded");
      this.#update();
      return file;
    } catch (error) {
      this.#statuses.delete(track.id);
      this.#update();
      throw error;
    }
  }

  cache(track: EngineTrack, options: TrackSourceOptions = {}) {
    const descriptor = this.#describe(track, options);
    const activeDownload = this.#downloads.get(descriptor.cacheKey);
    if (activeDownload) return activeDownload;

    const download = this.#download(track, descriptor).finally(() =>
      this.#downloads.delete(descriptor.cacheKey),
    );
    this.#downloads.set(descriptor.cacheKey, download);
    return download;
  }

  async scanCached(tracks: EngineTrack[]) {
    let changed = false;
    let nextTrack = 0;

    const worker = async () => {
      while (nextTrack < tracks.length) {
        const track = tracks[nextTrack++];
        const cached = await this.#store.get(this.#describe(track).cacheKey);
        if (cached && this.#statuses.get(track.id) !== "downloaded") {
          this.#statuses.set(track.id, "downloaded");
          changed = true;
        }
      }
    };

    await Promise.allSettled(Array.from({ length: Math.min(8, tracks.length) }, worker));
    if (changed) this.#update();
  }

  getStatus(trackId: string): TrackStatus {
    this.#subscribe();
    return this.#statuses.get(trackId) ?? "idle";
  }

  async getSource(track: EngineTrack, options: TrackSourceOptions = {}): Promise<TrackSource> {
    const request = ++this.#sourceRequest;
    const descriptor = this.#describe(track, options);
    const cached = await this.#store.get(descriptor.cacheKey);
    if (request !== this.#sourceRequest) {
      throw new DOMException("Source request superseded.", "AbortError");
    }

    this.#clearObjectUrl();
    if (!cached) return { cached: false, url: descriptor.url };

    this.#statuses.set(track.id, "downloaded");
    this.#update();
    this.#activeObjectUrl = URL.createObjectURL(
      new Blob([cached], { type: descriptor.contentType }),
    );
    return { cached: true, url: this.#activeObjectUrl };
  }

  releaseSource() {
    this.#sourceRequest += 1;
    this.#clearObjectUrl();
  }

  setAuth(auth: TrackEngineAuth) {
    const accountChanged =
      this.#auth && (this.#auth.host !== auth.host || this.#auth.username !== auth.username);
    this.#auth = auth;
    if (accountChanged) {
      this.#statuses.clear();
      this.#update();
    }
  }

  destroy() {
    this.releaseSource();
  }
}

class OpfsTrackStore implements TrackStore {
  async #directory() {
    const root = await navigator.storage.getDirectory();
    return root.getDirectoryHandle("tracks", { create: true });
  }

  async #fileName(key: string) {
    const data = new TextEncoder().encode(key);
    const digest = await crypto.subtle.digest("SHA-256", data);
    const hash = Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
    return `${hash}.audio`;
  }

  async get(key: string) {
    const cache = await this.#directory();
    try {
      const handle = await cache.getFileHandle(await this.#fileName(key));
      return await handle.getFile();
    } catch (error) {
      if (error instanceof DOMException && error.name === "NotFoundError") return null;
      throw error;
    }
  }

  async put(key: string, response: Response) {
    const cache = await this.#directory();
    const name = await this.#fileName(key);
    const handle = await cache.getFileHandle(name, { create: true });
    const writable = await handle.createWritable();

    try {
      if (response.body) await response.body.pipeTo(writable);
      else {
        await writable.write(await response.blob());
        await writable.close();
      }
      return await handle.getFile();
    } catch (error) {
      await writable.abort().catch(() => {});
      await cache.removeEntry(name).catch(() => {});
      throw error;
    }
  }
}
