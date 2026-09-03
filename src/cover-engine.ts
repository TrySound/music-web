import { createSubscriber } from "svelte/reactivity";

export interface CoverEngineAuth {
  host: string;
  username: string;
  token: string;
  salt: string;
}

export interface CoverRequest {
  candidates: readonly (string | undefined)[];
  allowNetwork: boolean;
}

export interface Cover {
  readonly source: string | undefined;
  readonly cache: () => void;
}

interface CachedCover {
  etag?: string;
  file: File;
  lastModified?: string;
  type: string;
}

interface CacheResult {
  cover: CachedCover;
  changed: boolean;
}

interface CoverEntry {
  cover: Cover;
  generation: number;
  network?: { cacheKey: string; url: string };
  source?: string;
}

interface ResolvedCover {
  network?: { cacheKey: string; url: string };
  source?: string;
}

export class CoverEngine {
  #auth?: CoverEngineAuth;
  #covers = new Map<string, CoverEntry>();
  #downloads = new Map<string, Promise<CacheResult>>();
  #generation = 0;
  #objectUrls = new Map<string, string>();
  #update = () => {};
  #subscribe = createSubscriber((update) => {
    this.#update = update;
    return () => {
      this.#update = () => {};
    };
  });

  #cache(key: string, url: string) {
    const activeDownload = this.#downloads.get(key);
    if (activeDownload) return activeDownload;

    const download = this.#download(key, url).finally(() => this.#downloads.delete(key));
    this.#downloads.set(key, download);
    return download;
  }

  #cacheKey(id: string, auth: CoverEngineAuth) {
    return `${auth.host}\n${auth.username}\n${id}`;
  }

  async #cacheFileName(key: string) {
    const data = new TextEncoder().encode(key);
    const digest = await crypto.subtle.digest("SHA-256", data);
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(
      "",
    );
  }

  async #directory() {
    const root = await navigator.storage.getDirectory();
    return root.getDirectoryHandle("images", { create: true });
  }

  #coverUrl(id: string, auth: CoverEngineAuth) {
    const query = new URLSearchParams({
      id,
      u: auth.username,
      t: auth.token,
      s: auth.salt,
      v: "1.16.1",
      c: "navidrome-artists",
      size: "500",
    });
    return `${auth.host}/rest/getCoverArt.view?${query}`;
  }

  async #download(key: string, url: string): Promise<CacheResult> {
    const cached = await this.#getCached(key);
    if (cached && !cached.etag && !cached.lastModified) {
      return { cover: cached, changed: false };
    }

    const headers = new Headers();
    if (cached?.etag) headers.set("If-None-Match", cached.etag);
    if (cached?.lastModified) headers.set("If-Modified-Since", cached.lastModified);

    const response = await fetch(url, { headers });
    if (response.status === 304 && cached) return { cover: cached, changed: false };
    if (!response.ok) throw new Error(`The server returned HTTP ${response.status}.`);

    const directory = await this.#directory();
    const name = await this.#cacheFileName(key);
    const type = response.headers.get("Content-Type") ?? "image/jpeg";
    const etag = response.headers.get("ETag") ?? undefined;
    const lastModified = response.headers.get("Last-Modified") ?? undefined;
    const [imageHandle, metadataHandle] = await Promise.all([
      directory.getFileHandle(`${name}.image`, { create: true }),
      directory.getFileHandle(`${name}.json`, { create: true }),
    ]);
    const [imageWritable, metadataWritable] = await Promise.all([
      imageHandle.createWritable(),
      metadataHandle.createWritable(),
    ]);

    try {
      await Promise.all([
        response.body
          ? response.body.pipeTo(imageWritable)
          : response.blob().then(async (blob) => {
              await imageWritable.write(blob);
              await imageWritable.close();
            }),
        metadataWritable
          .write(JSON.stringify({ etag, lastModified, type }))
          .then(() => metadataWritable.close()),
      ]);
      return {
        cover: { etag, file: await imageHandle.getFile(), lastModified, type },
        changed: true,
      };
    } catch (error) {
      await Promise.all([
        imageWritable.abort().catch(() => {}),
        metadataWritable.abort().catch(() => {}),
        directory.removeEntry(`${name}.image`).catch(() => {}),
        directory.removeEntry(`${name}.json`).catch(() => {}),
      ]);
      throw error;
    }
  }

  async #getCached(key: string): Promise<CachedCover | null> {
    const directory = await this.#directory();
    const name = await this.#cacheFileName(key);

    try {
      const [imageHandle, metadataHandle] = await Promise.all([
        directory.getFileHandle(`${name}.image`),
        directory.getFileHandle(`${name}.json`),
      ]);
      const [file, metadata] = await Promise.all([
        imageHandle.getFile(),
        metadataHandle.getFile().then(
          async (value) =>
            JSON.parse(await value.text()) as {
              etag?: string;
              lastModified?: string;
              type?: string;
            },
        ),
      ]);
      return {
        etag: metadata.etag,
        file,
        lastModified: metadata.lastModified,
        type: metadata.type ?? "image/jpeg",
      };
    } catch (error) {
      if (error instanceof DOMException && error.name === "NotFoundError") return null;
      throw error;
    }
  }

  #install(id: string, cached: CachedCover) {
    const existing = this.#objectUrls.get(id);
    if (existing) return existing;

    const url = URL.createObjectURL(new Blob([cached.file], { type: cached.type }));
    this.#objectUrls.set(id, url);
    return url;
  }

  #revalidate(id: string, cachedUrl: string, auth: CoverEngineAuth) {
    const generation = this.#generation;
    this.#cache(this.#cacheKey(id, auth), this.#coverUrl(id, auth))
      .then((result) => {
        if (!result.changed || generation !== this.#generation) return;

        const updatedUrl = URL.createObjectURL(
          new Blob([result.cover.file], { type: result.cover.type }),
        );
        this.#objectUrls.set(id, updatedUrl);
        for (const entry of this.#covers.values()) {
          if (entry.source === cachedUrl) entry.source = updatedUrl;
        }
        URL.revokeObjectURL(cachedUrl);
        this.#update();
      })
      .catch(() => {});
  }

  async #resolve(
    candidates: string[],
    allowNetwork: boolean,
    auth: CoverEngineAuth,
  ): Promise<ResolvedCover> {
    for (const id of candidates) {
      const objectUrl = this.#objectUrls.get(id);
      if (objectUrl) return { source: objectUrl };

      const cached = await this.#getCached(this.#cacheKey(id, auth)).catch(() => null);
      if (cached) {
        const cachedUrl = this.#install(id, cached);
        if (allowNetwork) this.#revalidate(id, cachedUrl, auth);
        return { source: cachedUrl };
      }
    }

    if (allowNetwork && candidates[0]) {
      const url = this.#coverUrl(candidates[0], auth);
      return {
        network: { cacheKey: this.#cacheKey(candidates[0], auth), url },
        source: url,
      };
    }
    return {};
  }

  #releaseObjectUrls() {
    for (const url of this.#objectUrls.values()) URL.revokeObjectURL(url);
    this.#objectUrls.clear();
  }

  #cacheEntry(entry: CoverEntry) {
    const network = entry.network;
    if (!network || entry.generation !== this.#generation) return;

    this.#cache(network.cacheKey, network.url)
      .then(() => {
        if (entry.network === network) entry.network = undefined;
      })
      .catch(() => {});
  }

  getCover(request: CoverRequest): Cover {
    this.#subscribe();
    const candidates = [...new Set(request.candidates.filter((id): id is string => Boolean(id)))];
    const key = JSON.stringify([request.allowNetwork, candidates]);
    const existing = this.#covers.get(key);
    if (existing) return existing.cover;

    const engine = this;
    let entry: CoverEntry;
    const cover: Cover = {
      get source() {
        engine.#subscribe();
        return entry.source;
      },
      cache: () => this.#cacheEntry(entry),
    };
    entry = { cover, generation: this.#generation };
    this.#covers.set(key, entry);

    const auth = this.#auth;
    if (auth) {
      this.#resolve(candidates, request.allowNetwork, auth)
        .then((resolved) => {
          if (entry.generation !== this.#generation || resolved.source === undefined) return;
          entry.network = resolved.network;
          entry.source = resolved.source;
          this.#update();
        })
        .catch(() => {});
    }
    return cover;
  }

  setAuth(auth: CoverEngineAuth) {
    const accountChanged =
      this.#auth && (this.#auth.host !== auth.host || this.#auth.username !== auth.username);
    if (accountChanged) this.#releaseObjectUrls();
    this.#auth = auth;
    this.#generation += 1;
    this.#covers.clear();
    this.#update();
  }

  destroy() {
    this.#generation += 1;
    this.#covers.clear();
    this.#releaseObjectUrls();
  }
}
