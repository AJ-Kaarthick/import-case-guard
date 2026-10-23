import * as path from 'path';
import * as jsonc from 'jsonc-parser';
import { IFileSystem } from './fileSystem';

export interface PathMapping {
  /** Original pattern from compilerOptions.paths, e.g. "@/*" or "@app" */
  pattern: string;
  hasWildcard: boolean;
  prefix: string;
  suffix: string;
  /** Substitution targets, e.g. ["src/*", "common/*"] */
  targets: string[];
  /** Effective base directory where targets are resolved */
  baseDir: string;
  /** Path to the config file where this mapping was defined */
  configFilePath: string;
}

export interface AliasConfig {
  configFilePath: string;
  configDir: string;
  baseUrl?: string;
  mappings: PathMapping[];
  /** If true, inheritance (extends) failed, was circular, or missing */
  isIncomplete: boolean;
}

export interface TsConfigJson {
  extends?: string | string[];
  compilerOptions?: {
    baseUrl?: string;
    paths?: Record<string, string[]>;
    [key: string]: any;
  };
  [key: string]: any;
}

/**
 * Parses a paths pattern into prefix, suffix, and wildcard flag.
 * For example:
 * - "@/*" -> prefix: "@/", suffix: "", hasWildcard: true
 * - "@app" -> prefix: "@app", suffix: "", hasWildcard: false
 * - "shared/*" -> prefix: "shared/", suffix: "", hasWildcard: true
 * - "prefix*suffix" -> prefix: "prefix", suffix: "suffix", hasWildcard: true
 */
export function parsePattern(pattern: string): { prefix: string; suffix: string; hasWildcard: boolean } {
  const starIdx = pattern.indexOf('*');
  if (starIdx === -1) {
    return {
      prefix: pattern,
      suffix: '',
      hasWildcard: false,
    };
  }
  return {
    prefix: pattern.slice(0, starIdx),
    suffix: pattern.slice(starIdx + 1),
    hasWildcard: true,
  };
}

/**
 * Searches parent directories for the nearest configuration file governing filePath.
 * Priority:
 * - For .ts / .tsx files: searches for tsconfig.json. (jsconfig.json does not govern TS).
 * - For .js / .jsx / .mjs / .cjs files: in each directory, checks for tsconfig.json first,
 *   then jsconfig.json. If both exist in the same directory, tsconfig.json takes precedence.
 * Stops when reaching a workspace root or filesystem root.
 */
export function findConfigFile(
  filePath: string,
  fs: IFileSystem,
  workspaceRoots?: string[]
): string | null {
  const ext = path.extname(filePath).toLowerCase();
  const isTs = ext === '.ts' || ext === '.tsx';

  const normalizedRoots = (workspaceRoots || []).map((r) => path.normalize(r));
  let currentDir = path.dirname(path.normalize(filePath));

  while (true) {
    const tsconfigPath = path.join(currentDir, 'tsconfig.json');
    if (fs.fileExists(tsconfigPath)) {
      return tsconfigPath;
    }

    if (!isTs) {
      const jsconfigPath = path.join(currentDir, 'jsconfig.json');
      if (fs.fileExists(jsconfigPath)) {
        return jsconfigPath;
      }
    }

    // Stop if we reached a workspace root
    const atWorkspaceRoot = normalizedRoots.some((r) => r === currentDir);
    if (atWorkspaceRoot) {
      break;
    }

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      // Reached filesystem root
      break;
    }
    currentDir = parentDir;
  }

  return null;
}

/**
 * Loads and resolves an alias configuration from tsconfig.json or jsconfig.json,
 * safely resolving local `extends` inheritance without crashing on missing,
 * malformed, or circular configurations.
 */
export function loadAliasConfig(
  configPath: string,
  fs: IFileSystem,
  visited: Set<string> = new Set()
): AliasConfig | null {
  const normPath = path.normalize(configPath);
  if (visited.has(normPath)) {
    // Circular inheritance detected!
    return {
      configFilePath: normPath,
      configDir: path.dirname(normPath),
      mappings: [],
      isIncomplete: true,
    };
  }
  visited.add(normPath);

  const content = fs.readFile(normPath);
  if (content === null) {
    return null;
  }

  const parseErrors: jsonc.ParseError[] = [];
  const parsedData = jsonc.parse(content, parseErrors, { allowTrailingComma: true }) as TsConfigJson;

  if (parseErrors.length > 0 || !parsedData || typeof parsedData !== 'object') {
    // Malformed JSONC
    return {
      configFilePath: normPath,
      configDir: path.dirname(normPath),
      mappings: [],
      isIncomplete: true,
    };
  }

  const configDir = path.dirname(normPath);
  let isIncomplete = false;

  // Base configurations inherited via `extends`
  let inheritedMappings: PathMapping[] = [];

  if (parsedData.extends) {
    const rawExtends = Array.isArray(parsedData.extends) ? parsedData.extends : [parsedData.extends];
    for (const extRef of rawExtends) {
      if (typeof extRef !== 'string' || !extRef.trim()) continue;

      let resolvedExtPath: string | null = null;
      if (extRef.startsWith('.')) {
        // Relative extends
        const candidate = path.resolve(configDir, extRef);
        if (fs.fileExists(candidate)) {
          resolvedExtPath = candidate;
        } else if (fs.fileExists(candidate + '.json')) {
          resolvedExtPath = candidate + '.json';
        }
      } else {
        // Non-relative or node_modules extends
        // Check if node_modules package extends can be resolved locally
        const candidateInNodeModules = path.resolve(configDir, 'node_modules', extRef);
        if (fs.fileExists(candidateInNodeModules)) {
          resolvedExtPath = candidateInNodeModules;
        } else if (fs.fileExists(candidateInNodeModules + '.json')) {
          resolvedExtPath = candidateInNodeModules + '.json';
        }
      }

      if (!resolvedExtPath) {
        // Missing or unsupported extends
        isIncomplete = true;
      } else {
        const baseConfig = loadAliasConfig(resolvedExtPath, fs, new Set(visited));
        if (!baseConfig || baseConfig.isIncomplete) {
          isIncomplete = true;
        } else {
          inheritedMappings.push(...baseConfig.mappings);
        }
      }
    }
  }

  const compilerOptions = parsedData.compilerOptions || {};
  const baseUrl = compilerOptions.baseUrl ? String(compilerOptions.baseUrl) : undefined;
  const effectiveBaseDir = baseUrl ? path.resolve(configDir, baseUrl) : configDir;

  const currentMappings: PathMapping[] = [];
  if (compilerOptions.paths && typeof compilerOptions.paths === 'object') {
    for (const [pattern, rawTargets] of Object.entries(compilerOptions.paths)) {
      if (!pattern || typeof pattern !== 'string') continue;
      if (!Array.isArray(rawTargets)) continue;

      const targets = rawTargets.filter((t) => typeof t === 'string' && t.length > 0);
      if (targets.length === 0) continue;

      const { prefix, suffix, hasWildcard } = parsePattern(pattern);
      currentMappings.push({
        pattern,
        hasWildcard,
        prefix,
        suffix,
        targets,
        baseDir: effectiveBaseDir,
        configFilePath: normPath,
      });
    }
  }

  // Combine inherited and current mappings:
  // Child mappings override base mappings with the same pattern key
  const finalMappingsMap = new Map<string, PathMapping>();
  for (const m of inheritedMappings) {
    finalMappingsMap.set(m.pattern, m);
  }
  for (const m of currentMappings) {
    finalMappingsMap.set(m.pattern, m);
  }

  return {
    configFilePath: normPath,
    configDir,
    baseUrl,
    mappings: Array.from(finalMappingsMap.values()),
    isIncomplete,
  };
}

/**
 * Finds all candidate mappings matching the import specifier, sorted by TypeScript priority:
 * 1. Exact match patterns (no wildcard) take precedence over wildcard patterns.
 * 2. Wildcard patterns with longer prefixes take precedence over shorter prefixes.
 * 3. Wildcard patterns with equal prefixes are disambiguated by longer suffixes.
 */
export function getMatchingMappings(specifier: string, mappings: PathMapping[]): PathMapping[] {
  const matches: PathMapping[] = [];

  for (const m of mappings) {
    if (!m.hasWildcard) {
      if (m.pattern === specifier) {
        matches.push(m);
      }
    } else {
      if (
        specifier.startsWith(m.prefix) &&
        specifier.endsWith(m.suffix) &&
        specifier.length >= m.prefix.length + m.suffix.length
      ) {
        matches.push(m);
      }
    }
  }

  // Sort by TypeScript priority
  matches.sort((a, b) => {
    // 1. Exact matches first
    if (!a.hasWildcard && b.hasWildcard) return -1;
    if (a.hasWildcard && !b.hasWildcard) return 1;

    // 2. Longer prefix first
    if (b.prefix.length !== a.prefix.length) {
      return b.prefix.length - a.prefix.length;
    }

    // 3. Longer suffix first
    return b.suffix.length - a.suffix.length;
  });

  return matches;
}

/**
 * Manages parsed configuration files with caching and directory-level invalidation.
 */
export class AliasConfigManager {
  private configCache = new Map<string, AliasConfig | null>();
  private fileToConfigMap = new Map<string, string | null>();

  getConfigForFile(
    filePath: string,
    fs: IFileSystem,
    workspaceRoots?: string[]
  ): AliasConfig | null {
    const normFile = path.normalize(filePath);
    if (this.fileToConfigMap.has(normFile)) {
      const cachedConfigPath = this.fileToConfigMap.get(normFile);
      if (!cachedConfigPath) return null;
      return this.configCache.get(cachedConfigPath) ?? null;
    }

    const configPath = findConfigFile(normFile, fs, workspaceRoots);
    this.fileToConfigMap.set(normFile, configPath);

    if (!configPath) {
      return null;
    }

    if (this.configCache.has(configPath)) {
      return this.configCache.get(configPath) ?? null;
    }

    const loaded = loadAliasConfig(configPath, fs);
    this.configCache.set(configPath, loaded);
    return loaded;
  }

  invalidateConfig(configPath: string): void {
    const norm = path.normalize(configPath);
    this.configCache.delete(norm);
    this.fileToConfigMap.clear();
  }

  invalidateAll(): void {
    this.configCache.clear();
    this.fileToConfigMap.clear();
  }

  isDocumentAffectedByConfig(docPath: string, configPath: string): boolean {
    const normDoc = path.normalize(docPath);
    const normConfig = path.normalize(configPath);
    const configDir = path.dirname(normConfig);

    // If document is inside config directory tree
    return normDoc.startsWith(configDir + path.sep) || normDoc === normConfig;
  }
}
