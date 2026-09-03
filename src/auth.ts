import { md5 } from "js-md5";
import * as v from "valibot";
import type { SubsonicAuth } from "./subsonic-client";

export interface PasswordAuth {
  host: string;
  username: string;
  password: string;
}

const authSchema = v.object({
  host: v.pipe(v.string(), v.url()),
  username: v.pipe(v.string(), v.nonEmpty()),
  token: v.pipe(v.string(), v.nonEmpty()),
  salt: v.pipe(v.string(), v.nonEmpty()),
});

export class AuthStore {
  #key: string;
  #storage: Storage;

  constructor(storage: Storage = localStorage, key = "navidrome-auth") {
    this.#storage = storage;
    this.#key = key;
  }

  #normalizeHost(value: string) {
    const withProtocol = /^https?:\/\//i.test(value) ? value : `https://${value}`;
    return new URL(withProtocol).toString().replace(/\/$/, "");
  }

  #salt() {
    const bytes = crypto.getRandomValues(new Uint8Array(12));
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  create(input: PasswordAuth): SubsonicAuth {
    const salt = this.#salt();
    return v.parse(authSchema, {
      host: this.#normalizeHost(input.host.trim()),
      username: input.username,
      token: md5(input.password + salt),
      salt,
    });
  }

  load(): SubsonicAuth | null {
    const value = this.#storage.getItem(this.#key);
    if (!value) return null;
    try {
      return v.parse(authSchema, JSON.parse(value));
    } catch {
      throw new Error("The saved Subsonic authentication is invalid.");
    }
  }

  save(auth: SubsonicAuth) {
    this.#storage.setItem(this.#key, JSON.stringify(v.parse(authSchema, auth)));
  }

  clear() {
    this.#storage.removeItem(this.#key);
  }
}
