import { afterEach, describe, expect, it, vi } from "vitest";
import { CoverEngine, type CoverRequest } from "./cover-engine";

const auth = {
  host: "https://music.example.com",
  username: "listener",
  token: "token",
  salt: "salt",
};

function installOpfs(cached = false) {
  const files = new Map<string, File>();
  const handles = new Map<
    string,
    {
      createWritable(): Promise<WritableStream<Uint8Array>>;
      getFile(): Promise<File>;
    }
  >();

  const directory = {
    async getFileHandle(name: string, options?: { create?: boolean }) {
      if (cached && !files.has(name)) {
        files.set(
          name,
          name.endsWith(".json")
            ? new File([JSON.stringify({ type: "image/jpeg" })], name)
            : new File(["image"], name),
        );
      }
      if (!files.has(name) && !options?.create) throw new DOMException("Missing", "NotFoundError");
      if (!handles.has(name)) {
        handles.set(name, {
          async createWritable() {
            const chunks: BlobPart[] = [];
            const commit = () => {
              files.set(name, new File(chunks, name));
            };
            const stream = new WritableStream<Uint8Array>({
              write(chunk) {
                chunks.push(chunk.slice().buffer as ArrayBuffer);
              },
              close: commit,
              abort() {
                files.delete(name);
              },
            });
            return Object.assign(stream, {
              async write(chunk: BlobPart) {
                chunks.push(chunk);
              },
              async close() {
                commit();
              },
              async abort() {
                files.delete(name);
              },
            });
          },
          async getFile() {
            const file = files.get(name);
            if (!file) throw new DOMException("Missing", "NotFoundError");
            return file;
          },
        });
      }
      return handles.get(name)!;
    },
    async removeEntry(name: string) {
      files.delete(name);
    },
  };

  vi.stubGlobal("navigator", {
    storage: {
      async getDirectory() {
        return {
          async getDirectoryHandle() {
            return directory;
          },
        };
      },
    },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("cover engine", () => {
  it("reactively resolves a cached object URL", async () => {
    installOpfs(true);
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:cached-cover");
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const engine = new CoverEngine();
    engine.setAuth(auth);
    const request = { candidates: ["cover-1"], allowNetwork: true };

    expect(engine.getSource(request)).toBeUndefined();
    await vi.waitFor(() => expect(engine.getSource(request)).toBe("blob:cached-cover"));
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("uses the first cached fallback", async () => {
    installOpfs(true);
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:fallback-cover");
    const engine = new CoverEngine();
    engine.setAuth(auth);
    const request = {
      candidates: [undefined, "album-cover", "track-cover"],
      allowNetwork: false,
    };

    await vi.waitFor(() => expect(engine.getSource(request)).toBe("blob:fallback-cover"));
  });

  it("resolves a Navidrome URL and caches it after loading", async () => {
    installOpfs();
    const fetcher = vi.fn(
      async () => new Response("image", { headers: { "Content-Type": "image/jpeg" } }),
    );
    vi.stubGlobal("fetch", fetcher);
    const engine = new CoverEngine();
    engine.setAuth(auth);
    const request: CoverRequest = { candidates: ["cover-1"], allowNetwork: true };

    let source: string | undefined;
    await vi.waitFor(() => {
      source = engine.getSource(request);
      expect(source).toContain("/rest/getCoverArt.view?");
    });
    expect(engine.cacheLoaded(source!)).toBeUndefined();
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
  });

  it("does not resolve a server URL when network access is disabled", async () => {
    installOpfs();
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const engine = new CoverEngine();
    engine.setAuth(auth);
    const request = { candidates: ["cover-1"], allowNetwork: false };

    expect(engine.getSource(request)).toBeUndefined();
    await new Promise((resolve) => setTimeout(resolve));
    expect(engine.getSource(request)).toBeUndefined();
    expect(fetcher).not.toHaveBeenCalled();
  });
});
