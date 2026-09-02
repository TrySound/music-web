const downloads = new Map<string, Promise<File>>();

async function cacheFileName(key: string) {
  const data = new TextEncoder().encode(key);
  const digest = await crypto.subtle.digest('SHA-256', data);
  const hash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hash}.audio`;
}

async function cacheDirectory() {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle('tracks', { create: true });
}

export async function getCachedTrack(key: string) {
  const directory = await cacheDirectory();

  try {
    const handle = await directory.getFileHandle(await cacheFileName(key));
    return await handle.getFile();
  } catch (caught) {
    if (caught instanceof DOMException && caught.name === 'NotFoundError') return null;
    throw caught;
  }
}

export function cacheTrack(key: string, url: string) {
  const activeDownload = downloads.get(key);
  if (activeDownload) return activeDownload;

  const download = downloadTrack(key, url).finally(() => downloads.delete(key));
  downloads.set(key, download);
  return download;
}

async function downloadTrack(key: string, url: string) {
  const cached = await getCachedTrack(key);
  if (cached) return cached;

  const directory = await cacheDirectory();
  const fileName = await cacheFileName(key);
  const handle = await directory.getFileHandle(fileName, { create: true });
  const writable = await handle.createWritable();

  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`The server returned HTTP ${response.status}.`);

    if (response.body) await response.body.pipeTo(writable);
    else {
      await writable.write(await response.blob());
      await writable.close();
    }

    return await handle.getFile();
  } catch (caught) {
    await writable.abort().catch(() => {});
    await directory.removeEntry(fileName).catch(() => {});
    throw caught;
  }
}
