import { beforeEach, describe, expect, it, vi } from "vitest";
import { RouterEngine } from "./router-engine";

class TestURLPattern {
  #expression: RegExp;
  #names: string[] = [];

  constructor(init: URLPatternInit) {
    const source = String(init.hash).replace(/:([A-Za-z]+)/g, (_, name: string) => {
      this.#names.push(name);
      return "([^/]+)";
    });
    this.#expression = new RegExp(`^${source}$`);
  }

  exec(input: string | URL) {
    const match = this.#expression.exec(new URL(input).hash.slice(1));
    if (!match) return null;
    return {
      hash: {
        groups: Object.fromEntries(this.#names.map((name, index) => [name, match[index + 1]])),
      },
    } as unknown as URLPatternResult;
  }

  test(input: string | URL) {
    return this.exec(input) !== null;
  }
}

beforeEach(() => {
  vi.stubGlobal("URLPattern", TestURLPattern);
});

const library = { pattern: "/library", name: "library" };
const artist = { pattern: "/library/artist/:artistId", name: "artist" };
const album = {
  pattern: "/library/artist/:artistId/album/:albumId",
  name: "album",
};
const player = { pattern: "/player", name: "player" };
const routes = [album, artist, library, player];

describe("router engine", () => {
  it("resolves user-defined routes with decoded parameters", () => {
    const router = new RouterEngine(routes, library);

    expect(router.resolve("https://app.example/#/library")).toEqual({
      route: library,
      params: {},
    });
    expect(router.resolve("https://app.example/#/library/artist/artist%201")).toEqual({
      route: artist,
      params: { artistId: "artist 1" },
    });
    expect(router.resolve("https://app.example/#/library/artist/artist-1/album/album-1")).toEqual({
      route: album,
      params: { artistId: "artist-1", albumId: "album-1" },
    });
  });

  it("manages hash prefixes internally", () => {
    const router = new RouterEngine(routes, library);
    expect(router.href("/player")).toBe("#/player");
    expect(router.href("player")).toBe("#/player");
    expect(router.href("#/player")).toBe("#/player");
  });

  it("defaults unknown routes to the configured fallback", () => {
    const router = new RouterEngine(routes, library);
    expect(router.resolve("https://app.example/#/unknown")).toEqual({
      route: library,
      params: {},
    });
  });
});
