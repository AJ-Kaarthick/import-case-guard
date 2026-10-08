import * as path from 'path';
import { DirectoryEntry, IFileSystem } from './fileSystem';

interface CacheEntry {
  entries: DirectoryEntry[];
  timestamp: number;
}

export class DirectoryCache {
  private cache: Map<string, CacheEntry> = new Map();
  private ttlMs: number;

  constructor(ttlMs = 5000) {
    this.ttlMs = ttlMs;
  }

  getEntries(dirPath: string, fs: IFileSystem): DirectoryEntry[] {
    const normalized = path.normalize(dirPath);
    const now = Date.now();
    const existing = this.cache.get(normalized);

    if (existing && now - existing.timestamp < this.ttlMs) {
      return existing.entries;
    }

    const entries = fs.readDir(normalized);
    this.cache.set(normalized, {
      entries,
      timestamp: now,
    });
    return entries;
  }

  /**
   * Invalidate a specific directory or all directories.
   */
  invalidate(dirPath?: string): void {
    if (!dirPath) {
      this.cache.clear();
      return;
    }
    const normalized = path.normalize(dirPath);
    this.cache.delete(normalized);
  }

  /**
   * When a file changes/created/deleted, invalidate its parent directory.
   */
  invalidateFile(filePath: string): string {
    const parentDir = path.normalize(path.dirname(filePath));
    this.invalidate(parentDir);
    return parentDir;
  }

  clear(): void {
    this.cache.clear();
  }
}
