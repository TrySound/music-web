import { createSubscriber } from "svelte/reactivity";

export interface QueueEngineAuth {
  host: string;
  username: string;
  token: string;
  salt: string;
}

export interface QueueTrack {
  album: string;
  artist: string;
  contentType?: string;
  coverArt?: string;
  id: string;
  title: string;
}

export interface QueueState {
  current?: string;
  position: number;
  tracks: readonly QueueTrack[];
}

export type QueueEngineStatus = "idle" | "loading" | "ready" | "saving" | "error";
export type QueueNetwork = "offline" | "online";

type RemoteTrack = Omit<QueueTrack, "album" | "artist"> & {
  album?: string;
  artist?: string;
};

interface SubsonicResponse {
  status: string;
  error?: { message?: string };
  playQueue?: {
    current?: string;
    entry?: RemoteTrack[];
    position?: number;
  };
}

interface SubsonicEnvelope {
  "subsonic-response"?: SubsonicResponse;
}

export class QueueEngine {
  #auth?: QueueEngineAuth;
  #current?: string;
  #error: unknown;
  #generation = 0;
  #network: QueueNetwork = "online";
  #position = 0;
  #saveTimer?: ReturnType<typeof setTimeout>;
  #status: QueueEngineStatus = "idle";
  #tracks: readonly QueueTrack[] = [];
  #update = () => {};
  #subscribe = createSubscriber((update) => {
    this.#update = update;
    return () => {
      this.#update = () => {};
    };
  });

  get current() {
    this.#subscribe();
    return this.#current;
  }

  get error() {
    this.#subscribe();
    return this.#error;
  }

  get position() {
    this.#subscribe();
    return this.#position;
  }

  get status() {
    this.#subscribe();
    return this.#status;
  }

  get tracks() {
    this.#subscribe();
    return this.#tracks;
  }

  #publish(state: QueueState) {
    this.#current = state.current;
    this.#position = state.position;
    this.#tracks = [...state.tracks];
    this.#update();
  }

  #state(): QueueState {
    return {
      current: this.#current,
      position: this.#position,
      tracks: this.#tracks,
    };
  }

  #query(auth: QueueEngineAuth) {
    return new URLSearchParams({
      u: auth.username,
      t: auth.token,
      s: auth.salt,
      v: "1.16.1",
      c: "navidrome-artists",
      f: "json",
    });
  }

  async #response(response: Response) {
    if (!response.ok) throw new Error(`The server returned HTTP ${response.status}.`);
    const body: SubsonicEnvelope = await response.json();
    const result = body["subsonic-response"];
    if (!result) throw new Error("The server returned an unexpected response.");
    if (result.status !== "ok") {
      throw new Error(result.error?.message || "Navidrome rejected the request.");
    }
    return result;
  }

  #load() {
    const auth = this.#auth;
    if (!auth || this.#network === "offline") return;

    const generation = ++this.#generation;
    this.#error = undefined;
    this.#status = "loading";
    this.#update();
    fetch(`${auth.host}/rest/getPlayQueue.view?${this.#query(auth)}`)
      .then((response) => this.#response(response))
      .then((result) => {
        if (generation !== this.#generation) return;
        const queue = result.playQueue;
        this.#publish({
          current: queue?.current,
          position: (queue?.position ?? 0) / 1000,
          tracks: (queue?.entry ?? []).map((track) => ({
            album: track.album ?? "Unknown album",
            artist: track.artist ?? "Unknown artist",
            contentType: track.contentType,
            coverArt: track.coverArt,
            id: track.id,
            title: track.title,
          })),
        });
        this.#status = "ready";
        this.#update();
      })
      .catch((error) => {
        if (generation !== this.#generation) return;
        this.#error = error;
        this.#status = "error";
        this.#update();
      });
  }

  async #save(state: QueueState) {
    const auth = this.#auth;
    if (!auth || this.#network === "offline") return;

    const generation = this.#generation;
    const query = this.#query(auth);
    for (const track of state.tracks) query.append("id", track.id);
    if (state.current) {
      query.set("current", state.current);
      query.set("position", String(Math.round(state.position * 1000)));
    }

    this.#error = undefined;
    this.#status = "saving";
    this.#update();
    try {
      const result = await this.#response(
        await fetch(`${auth.host}/rest/savePlayQueue.view`, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: query,
          keepalive: true,
        }),
      );
      if (result.status !== "ok") throw new Error("The queue could not be synchronized.");
      if (generation !== this.#generation) return;
      this.#status = "ready";
    } catch (error) {
      if (generation !== this.#generation) return;
      this.#error = error;
      this.#status = "error";
    }
    this.#update();
  }

  update(state: QueueState) {
    this.#publish(state);
    this.save();
  }

  setPosition(position: number) {
    if (position === this.#position) return;
    this.#position = position;
    this.#update();
  }

  save() {
    clearTimeout(this.#saveTimer);
    this.#saveTimer = setTimeout(() => {
      this.#saveTimer = undefined;
      this.#save(this.#state()).catch(() => {});
    }, 300);
  }

  flush() {
    clearTimeout(this.#saveTimer);
    this.#saveTimer = undefined;
    this.#save(this.#state()).catch(() => {});
  }

  setAuth(auth: QueueEngineAuth) {
    const unchanged =
      this.#auth &&
      this.#auth.host === auth.host &&
      this.#auth.username === auth.username &&
      this.#auth.token === auth.token &&
      this.#auth.salt === auth.salt;
    this.#auth = auth;
    if (!unchanged) this.#load();
  }

  setNetwork(network: QueueNetwork) {
    if (network === this.#network) return;
    this.#network = network;
    clearTimeout(this.#saveTimer);
    this.#saveTimer = undefined;
    if (network === "online") this.#load();
    else {
      this.#generation += 1;
      this.#status = "idle";
      this.#update();
    }
  }

  destroy() {
    this.#generation += 1;
    clearTimeout(this.#saveTimer);
    this.#saveTimer = undefined;
    this.#status = "idle";
    this.#update();
  }
}
