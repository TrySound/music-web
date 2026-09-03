import { afterEach, describe, expect, it, vi } from 'vitest';
import { TrackEngine } from './track-engine';

const auth = {
  host: 'https://music.example.com',
  username: 'listener',
  token: 'token',
  salt: 'salt'
};

function installOpfs(initialFile: File | null = null, canPlayType: CanPlayTypeResult = '') {
  let file = initialFile;
  const fileHandle = {
    async createWritable() {
      const chunks: BlobPart[] = [];
      return new WritableStream<Uint8Array>({
        write(chunk) {
          chunks.push(chunk.slice().buffer as ArrayBuffer);
        },
        close() {
          file = new File(chunks, 'track.audio');
        },
        abort() {
          file = null;
        }
      });
    },
    async getFile() {
      if (!file) throw new DOMException('Missing', 'NotFoundError');
      return file;
    }
  };
  const directory = {
    async getFileHandle(_name: string, options?: { create?: boolean }) {
      if (!file && !options?.create) throw new DOMException('Missing', 'NotFoundError');
      return fileHandle;
    },
    async removeEntry() {
      file = null;
    }
  };

  vi.stubGlobal('document', {
    createElement: () => ({ canPlayType: () => canPlayType })
  });
  vi.stubGlobal('navigator', {
    storage: {
      async getDirectory() {
        return {
          async getDirectoryHandle() {
            return directory;
          }
        };
      }
    }
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('track engine', () => {
  it('uses the original format when the browser supports it', async () => {
    installOpfs(null, 'probably');
    const engine = new TrackEngine({ auth });

    const source = await engine.getSource({ id: 'track-1', contentType: 'audio/flac' });

    expect(new URL(source.url).searchParams.get('format')).toBe('raw');
  });

  it('falls back to MP3 for unsupported formats', async () => {
    installOpfs();
    const engine = new TrackEngine({ auth });

    const source = await engine.getSource({ id: 'track-1', contentType: 'audio/unknown' });

    expect(new URL(source.url).searchParams.get('format')).toBe('mp3');
  });

  it('returns and releases an object URL for cached tracks', async () => {
    installOpfs(new File(['cached'], 'track.audio'));
    const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:cached-track');
    const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const engine = new TrackEngine({ auth });

    const source = await engine.getSource({ id: 'track-1', contentType: 'audio/flac' });

    expect(source.cached).toBe(true);
    expect(engine.getStatus('track-1')).toBe('downloaded');
    expect(source.url).toBe('blob:cached-track');
    expect(createObjectURL).toHaveBeenCalledOnce();
    engine.releaseSource();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:cached-track');
  });

  it('releases the previous object URL when resolving another source', async () => {
    installOpfs(new File(['cached'], 'track.audio'));
    vi.spyOn(URL, 'createObjectURL')
      .mockReturnValueOnce('blob:first-track')
      .mockReturnValueOnce('blob:second-track');
    const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const engine = new TrackEngine({ auth });

    await engine.getSource({ id: 'track-1', contentType: 'audio/flac' });
    await engine.getSource({ id: 'track-2', contentType: 'audio/flac' });

    expect(revokeObjectURL).toHaveBeenCalledWith('blob:first-track');
    engine.destroy();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:second-track');
  });

  it('returns the Navidrome URL when a track is not cached', async () => {
    installOpfs();
    const engine = new TrackEngine({ auth });

    const source = await engine.getSource({ id: 'track-1' });

    expect(source.cached).toBe(false);
    expect(source.url).toContain('/rest/stream.view?');
    expect(source).not.toHaveProperty('release');
  });

  it('loads cached track state without returning storage details', async () => {
    installOpfs(new File(['cached'], 'track.audio'));
    const engine = new TrackEngine({ auth });

    const result = await engine.scanCached([{ id: 'track-1' }, { id: 'track-2' }]);

    expect(result).toBeUndefined();
    expect(engine.getStatus('track-1')).toBe('downloaded');
    expect(engine.getStatus('track-2')).toBe('downloaded');
  });

  it('handles unavailable browser storage while scanning', async () => {
    installOpfs();
    vi.stubGlobal('navigator', {
      storage: { getDirectory: async () => Promise.reject(new Error('Storage unavailable')) }
    });
    const engine = new TrackEngine({ auth });

    await expect(engine.scanCached([{ id: 'track-1' }])).resolves.toBeUndefined();
  });

  it('exposes downloading and downloaded state', async () => {
    installOpfs();
    let statusDuringFetch = '';
    let engine: TrackEngine;
    const fetcher = vi.fn(async () => {
      statusDuringFetch = engine.getStatus('track-1');
      return new Response('audio');
    });
    vi.stubGlobal('fetch', fetcher);
    engine = new TrackEngine({ auth });
    const track = { id: 'track-1' };

    await Promise.all([engine.cache(track), engine.cache(track)]);

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(statusDuringFetch).toBe('downloading');
    expect(engine.getStatus(track.id)).toBe('downloaded');
  });
});
