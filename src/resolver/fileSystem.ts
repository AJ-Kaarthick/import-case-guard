import * as fs from 'fs';
import * as path from 'path';

export interface DirectoryEntry {
  name: string;
  isDirectory(): boolean;
  isFile(): boolean;
}

export interface IFileSystem {
  readDir(dirPath: string): DirectoryEntry[];
  stat(filePath: string): { isDirectory: boolean; isFile: boolean } | null;
  readFile(filePath: string): string | null;
}

export class NodeFileSystem implements IFileSystem {
  readDir(dirPath: string): DirectoryEntry[] {
    try {
      const entries = fs.readdirSync(dirPath, { withFileTypes: true });
      return entries.map((e) => {
        let isDir = e.isDirectory();
        let isFile = e.isFile();

        // If the entry is a symlink, resolve its type via fs.statSync (which follows symlinks)
        // Crucial: We preserve e.name as the symlink's literal entry name for casing comparison,
        // and do not alter resolution to realpath.
        if (e.isSymbolicLink()) {
          try {
            const targetStat = fs.statSync(path.join(dirPath, e.name));
            isDir = targetStat.isDirectory();
            isFile = targetStat.isFile();
          } catch {
            // Broken symlink (target does not exist)
            isDir = false;
            isFile = false;
          }
        }

        return {
          name: e.name,
          isDirectory: () => isDir,
          isFile: () => isFile,
        };
      });
    } catch {
      return [];
    }
  }

  stat(filePath: string): { isDirectory: boolean; isFile: boolean } | null {
    try {
      const st = fs.statSync(filePath);
      return {
        isDirectory: st.isDirectory(),
        isFile: st.isFile(),
      };
    } catch {
      return null;
    }
  }

  readFile(filePath: string): string | null {
    try {
      return fs.readFileSync(filePath, 'utf-8');
    } catch {
      return null;
    }
  }
}

/**
 * Mock file system for automated unit testing.
 * Can simulate case-insensitive operating systems (macOS APFS / Windows NTFS)
 * where stat/existsSync resolves case-insensitively, but directory listings preserve
 * the exact disk casing.
 */
export class MockFileSystem implements IFileSystem {
  private files: Map<string, { isDir: boolean; content?: string }> = new Map();
  private symlinks: Map<string, string> = new Map();
  public isCaseInsensitiveOS: boolean;

  constructor(isCaseInsensitiveOS = false) {
    this.isCaseInsensitiveOS = isCaseInsensitiveOS;
  }

  addFile(filePath: string, content = '') {
    const normalized = path.normalize(filePath);
    this.files.set(normalized, { isDir: false, content });
    // Also ensure parent directories exist
    let parent = path.dirname(normalized);
    while (parent && parent !== '.' && parent !== '/' && parent !== path.dirname(parent)) {
      this.files.set(parent, { isDir: true });
      parent = path.dirname(parent);
    }
    if (parent === '/' || parent === '.') {
      this.files.set(parent, { isDir: true });
    }
  }

  addDirectory(dirPath: string) {
    const normalized = path.normalize(dirPath);
    this.files.set(normalized, { isDir: true });
    let parent = path.dirname(normalized);
    while (parent && parent !== '.' && parent !== '/' && parent !== path.dirname(parent)) {
      this.files.set(parent, { isDir: true });
      parent = path.dirname(parent);
    }
  }

  addSymlink(symlinkPath: string, targetPath: string) {
    const normalized = path.normalize(symlinkPath);
    const targetNormalized = path.normalize(targetPath);
    this.symlinks.set(normalized, targetNormalized);
    let parent = path.dirname(normalized);
    while (parent && parent !== '.' && parent !== '/' && parent !== path.dirname(parent)) {
      this.files.set(parent, { isDir: true });
      parent = path.dirname(parent);
    }
    if (parent === '/' || parent === '.') {
      this.files.set(parent, { isDir: true });
    }
  }

  private resolveSymlinksInPath(inputPath: string): string {
    let normalized = path.normalize(inputPath);
    for (const [symlink, target] of this.symlinks.entries()) {
      if (normalized === symlink) {
        return target;
      }
      if (normalized.startsWith(symlink + path.sep) || normalized.startsWith(symlink + '/')) {
        const sub = normalized.slice(symlink.length);
        normalized = path.join(target, sub);
      }
    }
    return normalized;
  }

  private findMatchingPath(targetPath: string): string | null {
    const symResolved = this.resolveSymlinksInPath(targetPath);
    const normalized = path.normalize(symResolved);
    if (this.files.has(normalized)) {
      return normalized;
    }
    if (this.isCaseInsensitiveOS) {
      const targetLower = normalized.toLowerCase();
      for (const key of this.files.keys()) {
        if (key.toLowerCase() === targetLower) {
          return key;
        }
      }
    }
    return null;
  }

  readDir(dirPath: string): DirectoryEntry[] {
    const resolvedDir = this.findMatchingPath(dirPath);
    if (!resolvedDir) {
      return [];
    }

    const dirNormalized = path.normalize(resolvedDir);
    const entries: DirectoryEntry[] = [];
    const seen = new Set<string>();

    for (const [filePath, info] of this.files.entries()) {
      if (filePath === dirNormalized) continue;
      const parent = path.dirname(filePath);
      if (parent === dirNormalized) {
        const base = path.basename(filePath);
        if (!seen.has(base)) {
          seen.add(base);
          entries.push({
            name: base,
            isDirectory: () => info.isDir,
            isFile: () => !info.isDir,
          });
        }
      }
    }

    for (const [symlinkPath, targetPath] of this.symlinks.entries()) {
      if (symlinkPath === dirNormalized) continue;
      const parent = path.dirname(symlinkPath);
      if (parent === dirNormalized) {
        const base = path.basename(symlinkPath);
        if (!seen.has(base)) {
          seen.add(base);
          const resolvedTarget = this.findMatchingPath(targetPath);
          const targetInfo = resolvedTarget ? this.files.get(resolvedTarget) : undefined;
          entries.push({
            name: base,
            isDirectory: () => !!targetInfo?.isDir,
            isFile: () => (targetInfo ? !targetInfo.isDir : false),
          });
        }
      }
    }

    return entries;
  }

  stat(filePath: string): { isDirectory: boolean; isFile: boolean } | null {
    let resolved = this.findMatchingPath(filePath);
    if (!resolved) {
      // Check if symlink
      const normalized = path.normalize(filePath);
      const target = this.symlinks.get(normalized);
      if (target) {
        resolved = this.findMatchingPath(target);
      }
    }
    if (!resolved) {
      return null;
    }
    const info = this.files.get(resolved);
    if (!info) return null;
    return {
      isDirectory: info.isDir,
      isFile: !info.isDir,
    };
  }

  readFile(filePath: string): string | null {
    let resolved = this.findMatchingPath(filePath);
    if (!resolved) {
      const normalized = path.normalize(filePath);
      const target = this.symlinks.get(normalized);
      if (target) {
        resolved = this.findMatchingPath(target);
      }
    }
    if (!resolved) {
      return null;
    }
    const info = this.files.get(resolved);
    if (!info || info.isDir) {
      return null;
    }
    return info.content ?? '';
  }

  private history: Map<string, { isDir: boolean; content?: string }>[] = [];

  applyEdit(filePath: string, range: TextRange, newText: string): boolean {
    const normalized = path.normalize(filePath);
    const resolved = this.findMatchingPath(normalized) || normalized;
    const content = this.readFile(resolved);
    if (content === null) return false;

    // Snapshot for undo
    const snapshot = new Map<string, { isDir: boolean; content?: string }>();
    for (const [k, v] of this.files.entries()) {
      snapshot.set(k, { ...v });
    }
    this.history.push(snapshot);

    const updated = replaceRangeInText(content, range, newText);
    this.files.set(resolved, { isDir: false, content: updated });
    return true;
  }

  undo(): boolean {
    const prev = this.history.pop();
    if (!prev) return false;
    this.files = prev;
    return true;
  }
}

export interface TextRange {
  start: { line: number; character: number };
  end: { line: number; character: number };
}

export function getTextAtRange(content: string, range: TextRange): string {
  const lines = content.split('\n');
  if (range.start.line >= lines.length || range.end.line >= lines.length) {
    return '';
  }
  if (range.start.line === range.end.line) {
    return lines[range.start.line].slice(range.start.character, range.end.character);
  }
  let result = lines[range.start.line].slice(range.start.character);
  for (let l = range.start.line + 1; l < range.end.line; l++) {
    result += '\n' + lines[l];
  }
  result += '\n' + lines[range.end.line].slice(0, range.end.character);
  return result;
}

export function replaceRangeInText(content: string, range: TextRange, newText: string): string {
  const lines = content.split('\n');
  if (range.start.line >= lines.length || range.end.line >= lines.length) {
    return content;
  }
  if (range.start.line === range.end.line) {
    const line = lines[range.start.line];
    const before = line.slice(0, range.start.character);
    const after = line.slice(range.end.character);
    lines[range.start.line] = before + newText + after;
    return lines.join('\n');
  }

  const startLine = lines[range.start.line];
  const endLine = lines[range.end.line];
  const before = startLine.slice(0, range.start.character);
  const after = endLine.slice(range.end.character);

  const replacementLines = (before + newText + after).split('\n');
  lines.splice(range.start.line, range.end.line - range.start.line + 1, ...replacementLines);
  return lines.join('\n');
}
