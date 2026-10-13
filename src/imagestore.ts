// The last sky file and hero image, kept in the browser's IndexedDB so a reload brings them back (PLAN §15.2).
// IndexedDB is a local database with room for large files; nothing here leaves the browser.
// Its API reports results through callbacks, so each call is wrapped in a Promise. Every function fails
// quietly (resolving to null or doing nothing) if storage is blocked, as in a private window.

const DB_NAME = 'sky-builder';
const STORE = 'images';

export type ImageSlot = 'sky' | 'hero';

export interface StoredImage {
  name: string;
  blob: Blob;
}

/** Turns one IndexedDB request into a Promise. */
function done<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

let database: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  database ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return database;
}

async function withStore<T>(mode: IDBTransactionMode, use: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  return done(use(db.transaction(STORE, mode).objectStore(STORE)));
}

export async function saveImage(slot: ImageSlot, image: StoredImage): Promise<void> {
  try {
    await withStore('readwrite', (store) => store.put({ name: image.name, blob: image.blob }, slot));
  } catch {
    // Storage blocked or full: the image just won't come back after a reload.
  }
}

export async function loadImage(slot: ImageSlot): Promise<StoredImage | null> {
  try {
    const value: unknown = await withStore('readonly', (store) => store.get(slot));
    if (typeof value === 'object' && value !== null && 'name' in value && 'blob' in value
        && typeof value.name === 'string' && value.blob instanceof Blob) {
      return { name: value.name, blob: value.blob };
    }
  } catch {
    // Fall through: nothing to restore.
  }
  return null;
}

export async function clearImages(): Promise<void> {
  try {
    await withStore('readwrite', (store) => store.clear());
  } catch {
    // Nothing stored, or storage blocked.
  }
}
