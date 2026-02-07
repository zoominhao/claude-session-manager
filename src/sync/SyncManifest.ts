import * as fs from 'fs';
import * as path from 'path';

export interface ManifestEntry {
  size: number;
  mtimeMs: number;
  syncedAt: number;
  etag?: string;
}

export interface ManifestData {
  version: 1;
  lastSyncTime: number;
  files: Record<string, ManifestEntry>;
}

export class SyncManifest {
  private data: ManifestData;
  private filePath: string;

  constructor(storageDir: string) {
    this.filePath = path.join(storageDir, 'sync-manifest.json');
    this.data = { version: 1, lastSyncTime: 0, files: {} };
    this.load();
  }

  load(): void {
    try {
      if (fs.existsSync(this.filePath)) {
        this.data = JSON.parse(fs.readFileSync(this.filePath, 'utf-8'));
      }
    } catch {
      this.data = { version: 1, lastSyncTime: 0, files: {} };
    }
  }

  save(): void {
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2));
  }

  getEntry(relativePath: string): ManifestEntry | undefined {
    return this.data.files[relativePath];
  }

  setEntry(relativePath: string, entry: ManifestEntry): void {
    this.data.files[relativePath] = entry;
  }

  removeEntry(relativePath: string): void {
    delete this.data.files[relativePath];
  }

  getLastSyncTime(): number {
    return this.data.lastSyncTime;
  }

  setLastSyncTime(time: number): void {
    this.data.lastSyncTime = time;
  }

  getAllEntries(): Record<string, ManifestEntry> {
    return this.data.files;
  }
}
