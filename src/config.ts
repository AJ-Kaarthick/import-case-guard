import * as path from 'path';

export interface ExtensionConfig {
  enable: boolean;
  debounceMs: number;
  exclude: string[];
}

export const DEFAULT_CONFIG: ExtensionConfig = {
  enable: true,
  debounceMs: 300,
  exclude: [
    '**/node_modules/**',
    '**/dist/**',
    '**/build/**',
    '**/.git/**',
    '**/coverage/**',
    '**/.next/**',
    '**/.nuxt/**',
  ],
};

/**
 * Checks if a file path matches any of the glob exclusion patterns.
 * Evaluates against a workspace-relative path when workspaceRoot is provided
 * to prevent false positives when an ancestor directory happens to be named build/dist/coverage.
 */
export function isPathExcluded(
  filePath: string,
  excludePatterns: string[],
  workspaceRoot?: string
): boolean {
  if (!excludePatterns || excludePatterns.length === 0 || !filePath) {
    return false;
  }

  const normalizedFile = filePath.replace(/\\/g, '/');

  // Determine path relative to workspace root if provided
  let candidatePath = normalizedFile;
  if (workspaceRoot) {
    const normalizedWs = workspaceRoot.replace(/\\/g, '/');
    const rel = path.relative(normalizedWs, normalizedFile).replace(/\\/g, '/');
    if (!rel.startsWith('..') && !path.isAbsolute(rel)) {
      candidatePath = rel;
    }
  }

  for (const pattern of excludePatterns) {
    const normalizedPattern = pattern.replace(/\\/g, '/');
    if (matchesGlob(candidatePath, normalizedPattern)) {
      return true;
    }
  }

  return false;
}

/**
 * Lightweight glob pattern matcher supporting '*', '**', and '?'.
 */
export function matchesGlob(filePath: string, pattern: string): boolean {
  // Normalize leading and trailing slashes for consistent comparison
  const pathTarget = filePath.startsWith('/') ? filePath.slice(1) : filePath;
  const pat = pattern.startsWith('/') ? pattern.slice(1) : pattern;

  let regexStr = '^';
  let i = 0;
  const len = pat.length;

  while (i < len) {
    const c = pat[i];
    if (c === '*' && pat[i + 1] === '*') {
      // '**'
      if (pat[i + 2] === '/') {
        // '**/': matches zero or more path segments
        regexStr += '(?:(?:^|.*/))?';
        i += 3;
      } else {
        regexStr += '.*';
        i += 2;
      }
    } else if (c === '*') {
      // '*' matches within a single segment (no '/')
      regexStr += '[^/]*';
      i++;
    } else if (c === '?') {
      regexStr += '[^/]';
      i++;
    } else if ('/\\+?.()^$|{}[]'.includes(c)) {
      regexStr += '\\' + c;
      i++;
    } else {
      regexStr += c;
      i++;
    }
  }
  regexStr += '$';

  try {
    const regex = new RegExp(regexStr);
    return regex.test(pathTarget);
  } catch {
    return false;
  }
}
