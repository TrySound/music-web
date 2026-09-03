import { afterEach, describe, expect, it, vi } from "vitest";
import { QueueEngine } from "./queue-engine";

const auth = {
  host: "https://music.example.com",
  username: "listener",
  token: "token",
  salt: "salt",
};

function response(data: Record<string, unknown> = {}) {
  return new Response(JSON.stringify({ "subsonic-response": { status: "ok", ...data } }));
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("queue engine", () => {
  it("publishes the remote queue as reactive engine state", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        response({
          playQueue: {
            current: "track-1",
            position: 1200,
            entry: [{ id: "track-1", title: "Track", album: "Album", artist: "Artist" }],
          },
        }),
      ),
    );
    const engine = new QueueEngine();

    engine.setAuth(auth);
    await vi.waitFor(() => expect(engine.status).toBe("ready"));

    expect(engine.current).toBe("track-1");
    expect(engine.position).toBe(1.2);
    expect(engine.tracks).toEqual([
      {
        id: "track-1",
        title: "Track",
        album: "Album",
        artist: "Artist",
        contentType: undefined,
        coverArt: undefined,
      },
    ]);
  });

  it("debounces queue and player-state synchronization", async () => {
    vi.useFakeTimers();
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(response({ playQueue: {} }))
      .mockResolvedValue(response());
    vi.stubGlobal("fetch", fetcher);
    const engine = new QueueEngine();
    engine.setAuth(auth);
    await vi.runAllTimersAsync();

    engine.update({
      current: "track-1",
      position: 2.5,
      tracks: [{ id: "track-1", title: "Track", album: "Album", artist: "Artist" }],
    });
    engine.update({
      current: "track-1",
      position: 3,
      tracks: [{ id: "track-1", title: "Track", album: "Album", artist: "Artist" }],
    });
    await vi.advanceTimersByTimeAsync(300);

    expect(fetcher).toHaveBeenCalledTimes(2);
    const options = fetcher.mock.calls[1][1] as RequestInit;
    expect(String(options.body)).toContain("id=track-1");
    expect(String(options.body)).toContain("current=track-1");
    expect(String(options.body)).toContain("position=3000");
  });

  it("does not load or save while offline", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const engine = new QueueEngine();

    engine.setNetwork("offline");
    engine.setAuth(auth);
    engine.update({ tracks: [], position: 0 });
    engine.flush();
    await vi.runAllTimersAsync();

    expect(fetcher).not.toHaveBeenCalled();
    expect(engine.status).toBe("idle");
  });
});
