const downloads = new Map<string, Promise<CachedImage>>();

export interface CachedImage {
  etag?: string;
  file: File;
  lastModified?: string;
  type: string;
}

async function cacheFileName(key: string) {
  const data = new TextEncoder().encode(key);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function cacheDirectory() {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle('images', { create: true });
}

export async function getCachedImage(key: string): Promise<CachedImage | null> {
  const directory = await cacheDirectory();
  const name = await cacheFileName(key);

  try {
    const [imageHandle, metadataHandle] = await Promise.all([
      directory.getFileHandle(`${name}.image`),
      directory.getFileHandle(`${name}.json`)
    ]);
    const [file, metadata] = await Promise.all([
      imageHandle.getFile(),
      metadataHandle.getFile().then(async (value) =>
        JSON.parse(await value.text()) as {
          etag?: string;
          lastModified?: string;
          type?: string;
        }
      )
    ]);
    return {
      etag: metadata.etag,
      file,
      lastModified: metadata.lastModified,
      type: metadata.type ?? 'image/jpeg'
    };
  } catch (caught) {
    if (caught instanceof DOMException && caught.name === 'NotFoundError') return null;
    throw caught;
  }
}

export function cacheImage(key: string, url: string) {
  const activeDownload = downloads.get(key);
  if (activeDownload) return activeDownload;

  const download = downloadImage(key, url).finally(() => downloads.delete(key));
  downloads.set(key, download);
  return download;
}

async function downloadImage(key: string, url: string): Promise<CachedImage> {
  const cached = await getCachedImage(key);
  if (cached && !cached.etag && !cached.lastModified) return cached;

  const headers = new Headers();
  if (cached?.etag) headers.set('If-None-Match', cached.etag);
  if (cached?.lastModified) headers.set('If-Modified-Since', cached.lastModified);

  const response = await fetch(url, { headers });
  if (response.status === 304 && cached) return cached;
  if (!response.ok) throw new Error(`The server returned HTTP ${response.status}.`);

  const directory = await cacheDirectory();
  const name = await cacheFileName(key);
  const type = response.headers.get('Content-Type') ?? 'image/jpeg';
  const etag = response.headers.get('ETag') ?? undefined;
  const lastModified = response.headers.get('Last-Modified') ?? undefined;
  const [imageHandle, metadataHandle] = await Promise.all([
    directory.getFileHandle(`${name}.image`, { create: true }),
    directory.getFileHandle(`${name}.json`, { create: true })
  ]);
  const [imageWritable, metadataWritable] = await Promise.all([
    imageHandle.createWritable(),
    metadataHandle.createWritable()
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
        .then(() => metadataWritable.close())
    ]);
    return { etag, file: await imageHandle.getFile(), lastModified, type };
  } catch (caught) {
    await Promise.all([
      imageWritable.abort().catch(() => {}),
      metadataWritable.abort().catch(() => {}),
      directory.removeEntry(`${name}.image`).catch(() => {}),
      directory.removeEntry(`${name}.json`).catch(() => {})
    ]);
    throw caught;
  }
}
