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

interface CachedCover {
  etag?: string;
  file: File;
  lastModified?: string;
  type: string;
}

export class CoverEngine {
  #auth?: CoverEngineAuth;
  #downloads = new Map<string, Promise<CachedCover>>();
  #generation = 0;
  #objectUrls = new Map<string, string>();
  #sources = new Map<string, string | undefined>();
  #update = () => {};
  #subscribe = createSubscriber((update) => {
    this.#update = update;
    return () => {
      this.#update = () => {};
    };
  });

  async #cache(key: string, url: string) {
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

  async #download(key: string, url: string): Promise<CachedCover> {
    const cached = await this.#getCached(key);
    if (cached && !cached.etag && !cached.lastModified) return cached;

    const headers = new Headers();
    if (cached?.etag) headers.set("If-None-Match", cached.etag);
    if (cached?.lastModified) headers.set("If-Modified-Since", cached.lastModified);

    const response = await fetch(url, { headers });
    if (response.status === 304 && cached) return cached;
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
      return { etag, file: await imageHandle.getFile(), lastModified, type };
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

  async #resolve(candidates: string[], allowNetwork: boolean, auth: CoverEngineAuth) {
    for (const id of candidates) {
      const objectUrl = this.#objectUrls.get(id);
      if (objectUrl) return objectUrl;

      const cached = await this.#getCached(this.#cacheKey(id, auth)).catch(() => null);
      if (cached) return this.#install(id, cached);
    }

    if (allowNetwork && candidates[0]) return this.#coverUrl(candidates[0], auth);
    return undefined;
  }

  #releaseObjectUrls() {
    for (const url of this.#objectUrls.values()) URL.revokeObjectURL(url);
    this.#objectUrls.clear();
  }

  getSource(request: CoverRequest) {
    this.#subscribe();
    if (!this.#auth) return undefined;

    const candidates = [...new Set(request.candidates.filter((id): id is string => Boolean(id)))];
    const key = JSON.stringify([request.allowNetwork, candidates]);
    if (this.#sources.has(key)) return this.#sources.get(key);

    const auth = this.#auth;
    const generation = this.#generation;
    this.#sources.set(key, undefined);
    this.#resolve(candidates, request.allowNetwork, auth)
      .then((source) => {
        if (generation !== this.#generation) return;
        this.#sources.set(key, source);
        this.#update();
      })
      .catch(() => {
        if (generation !== this.#generation) return;
        this.#sources.set(key, undefined);
        this.#update();
      });
    return undefined;
  }

  cacheLoaded(sourceUrl: string) {
    if (!this.#auth) return;

    const source = new URL(sourceUrl);
    const id = source.searchParams.get("id");
    if (!id || source.href !== new URL(this.#coverUrl(id, this.#auth)).href) return;
    this.#cache(this.#cacheKey(id, this.#auth), source.href).catch(() => {});
  }

  setAuth(auth: CoverEngineAuth) {
    const accountChanged =
      this.#auth && (this.#auth.host !== auth.host || this.#auth.username !== auth.username);
    if (accountChanged) this.#releaseObjectUrls();
    this.#auth = auth;
    this.#generation += 1;
    this.#sources.clear();
    this.#update();
  }

  destroy() {
    this.#generation += 1;
    this.#sources.clear();
    this.#releaseObjectUrls();
    this.#update();
  }
}
