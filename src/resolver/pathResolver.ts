import * as path from 'path';
import { DirectoryCache } from './cache';
import { DirectoryEntry, IFileSystem } from './fileSystem';
import { isLocalRelativeImport } from '../scanner/importScanner';
import { AliasConfig, getMatchingMappings, PathMapping } from './aliasConfig';

export const SUPPORTED_SOURCE_EXTENSIONS = [
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.json',
];

export const INDEX_FILES = [
  'index.ts',
  'index.tsx',
  'index.js',
  'index.jsx',
  'index.mjs',
  'index.cjs',
  'index.json',
];

export interface CaseMismatchDiagnostic {
  hasMismatch: boolean;
  isAmbiguous: boolean;
  originalSpecifier: string;
  correctedSpecifier?: string;
  actualDiskPath?: string;
  matchedPattern?: string;
  message: string;
  details?: string;
}

interface ParsedRelativePath {
  prefix: string;
  separator: string;
  segments: string[];
  hasTrailingSlash: boolean;
}

/**
 * Parses a relative specifier into its prefix (e.g. './', '../', '../../')
 * and individual path segments.
 */
export function parseRelativeSpecifier(specifier: string): ParsedRelativePath | null {
  if (!specifier) return null;

  const isWindowsSep = specifier.includes('\\') && !specifier.includes('/');
  const separator = isWindowsSep ? '\\' : '/';
  const hasTrailingSlash = specifier.endsWith('/') || specifier.endsWith('\\');

  // Exact '.' or '..'
  if (specifier === '.' || specifier === '..') {
    return {
      prefix: specifier + separator,
      separator,
      segments: [],
      hasTrailingSlash: false,
    };
  }

  // Match leading relative navigation prefix:
  // Must be one or more '../' (or '..\'), optionally followed by './' (or '.\\')
  // OR './' (or '.\\').
  // Crucially: dots must be followed by a separator / or \ so that dotted segments
  // like '.storybook' or '.eslintrc' are not eaten into the navigation prefix!
  const prefixMatch = specifier.match(/^((?:\.\.[/\\])+(?:\.[/\\])?|\.[/\\])/);
  if (!prefixMatch) {
    return null;
  }

  const prefix = prefixMatch[1];
  const remainder = specifier.slice(prefix.length);

  // Split remainder into segments
  const rawSegments = remainder.split(/[/\\]/);
  const segments = rawSegments.filter((s) => s.length > 0);

  return {
    prefix,
    separator,
    segments,
    hasTrailingSlash,
  };
}

/**
 * Resolves a local relative import specifier segment-by-segment against the filesystem.
 * Distinguishes:
 * 1. Exact case match -> returns null (no diagnostic)
 * 2. Case mismatch -> returns CaseMismatchDiagnostic with corrected path
 * 3. File/Directory does not exist -> returns null (no diagnostic)
 * 4. Ambiguous case matches -> returns CaseMismatchDiagnostic without quick fix
 */
export function resolveAndValidateImport(
  importingFilePath: string,
  specifier: string,
  fs: IFileSystem,
  cache: DirectoryCache,
  aliasConfig?: AliasConfig | null
): CaseMismatchDiagnostic | null {
  if (!isLocalRelativeImport(specifier)) {
    // Non-relative import: check for path aliases
    if (!aliasConfig || aliasConfig.isIncomplete) {
      return null;
    }

    const matchingMappings = getMatchingMappings(specifier, aliasConfig.mappings);
    if (matchingMappings.length === 0) {
      return null; // Package import or unmapped import
    }

    // TypeScript module-resolution semantics:
    // The most specific matching pattern is selected. If its target substitutions fail
    // to resolve, resolution does NOT fall back to a less-specific matching pattern.
    const winningMapping = matchingMappings[0];
    return resolveAliasImport(importingFilePath, specifier, winningMapping, fs, cache);
  }

  const parsed = parseRelativeSpecifier(specifier);
  if (!parsed) {
    return null;
  }

  const { prefix, separator, segments, hasTrailingSlash } = parsed;

  // Multi-root and workspace independent: always base resolution on importing document's directory
  const docDir = path.dirname(path.normalize(importingFilePath));

  // Determine starting base directory by resolving prefix against docDir
  let currentDir: string;
  try {
    const normalizedPrefix = prefix.replace(/\\/g, '/');
    currentDir = path.resolve(docDir, normalizedPrefix);
  } catch {
    return null;
  }

  // If there are no segments (e.g. import './' or import '.'), check for index file in currentDir
  if (segments.length === 0) {
    // Check if index file exists in currentDir
    const entries = cache.getEntries(currentDir, fs);
    const hasIndex = entries.some((e) => INDEX_FILES.includes(e.name));
    if (hasIndex) {
      return null; // exact match
    }
    // Check if index exists with different casing (e.g. Index.ts)
    const indexMismatches = entries.filter((e) =>
      INDEX_FILES.some((idx) => idx.toLowerCase() === e.name.toLowerCase() && idx !== e.name)
    );
    if (indexMismatches.length > 0) {
      // Directory import itself is fine, index file on disk has unexpected casing
      return null;
    }
    return null;
  }

  const correctedSegments: string[] = [];
  let mismatchFound = false;
  let isAmbiguous = false;
  const mismatchDetails: string[] = [];

  // 1. Process intermediate directory segments (all except the last)
  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i];
    const entries = cache.getEntries(currentDir, fs);

    // Exact match directory
    const exactMatch = entries.find((e) => e.name === seg && e.isDirectory());
    if (exactMatch) {
      correctedSegments.push(seg);
      currentDir = path.join(currentDir, seg);
      continue;
    }

    // Case-insensitive match directory
    const segLower = seg.toLowerCase();
    const caseMatches = entries.filter(
      (e) => e.name.toLowerCase() === segLower && e.isDirectory()
    );

    if (caseMatches.length === 0) {
      // Directory segment does not exist at all -> not a casing issue, ignore
      return null;
    }

    if (caseMatches.length > 1) {
      // Ambiguous multiple directories with same lower-case name
      isAmbiguous = true;
      mismatchFound = true;
      correctedSegments.push(caseMatches[0].name);
      mismatchDetails.push(`Directory segment '${seg}' has multiple ambiguous matches on disk.`);
      currentDir = path.join(currentDir, caseMatches[0].name);
      continue;
    }

    // Single case-mismatched directory
    const actualDirName = caseMatches[0].name;
    mismatchFound = true;
    correctedSegments.push(actualDirName);
    mismatchDetails.push(`Directory segment '${seg}' on disk is '${actualDirName}'`);
    currentDir = path.join(currentDir, actualDirName);
  }

  // 2. Process final segment
  const lastSeg = segments[segments.length - 1];
  const entries = cache.getEntries(currentDir, fs);

  // Check if last segment is exact match:
  // Option A: exact file match directly (e.g. explicit extension or exact filename)
  const exactDirectFile = entries.find((e) => e.name === lastSeg && e.isFile());
  if (exactDirectFile) {
    correctedSegments.push(lastSeg);
    if (mismatchFound) {
      return buildResult(prefix, separator, correctedSegments, hasTrailingSlash, specifier, currentDir, mismatchDetails, isAmbiguous);
    }
    return null; // exact match across entire path
  }

  // Option B: exact extensionless file match (e.g. requested 'Button', disk has 'Button.tsx')
  let exactExtMatch: DirectoryEntry | null = null;
  for (const ext of SUPPORTED_SOURCE_EXTENSIONS) {
    const candidate = entries.find((e) => e.name === lastSeg + ext && e.isFile());
    if (candidate) {
      exactExtMatch = candidate;
      break;
    }
  }

  if (exactExtMatch) {
    correctedSegments.push(lastSeg);
    if (mismatchFound) {
      return buildResult(prefix, separator, correctedSegments, hasTrailingSlash, specifier, currentDir, mismatchDetails, isAmbiguous);
    }
    return null; // exact match
  }

  // Option C: exact directory with index file (e.g. requested 'utils', disk has 'utils/index.ts')
  const exactDir = entries.find((e) => e.name === lastSeg && e.isDirectory());
  if (exactDir) {
    const subEntries = cache.getEntries(path.join(currentDir, exactDir.name), fs);
    const hasIndex = subEntries.some((e) => INDEX_FILES.includes(e.name));
    if (hasIndex) {
      correctedSegments.push(lastSeg);
      if (mismatchFound) {
        return buildResult(prefix, separator, correctedSegments, hasTrailingSlash, specifier, currentDir, mismatchDetails, isAmbiguous);
      }
      return null; // exact match
    }
  }

  // If no exact match, search for case-insensitive candidates on the final segment!
  const lastSegLower = lastSeg.toLowerCase();

  // Candidate 1: Case-mismatched file with explicit extension or full match
  // e.g. requested 'button.tsx', disk has 'Button.tsx'
  const caseDirectFiles = entries.filter(
    (e) => e.name.toLowerCase() === lastSegLower && e.isFile()
  );

  // Candidate 2: Case-mismatched extensionless file
  // e.g. requested 'button', disk has 'Button.tsx'
  interface ExtensionlessCandidate {
    entry: DirectoryEntry;
    diskBaseName: string;
    ext: string;
  }
  const caseExtensionlessCandidates: ExtensionlessCandidate[] = [];

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    for (const ext of SUPPORTED_SOURCE_EXTENSIONS) {
      if (entry.name.toLowerCase().endsWith(ext.toLowerCase())) {
        const base = entry.name.slice(0, entry.name.length - ext.length);
        if (base.toLowerCase() === lastSegLower) {
          caseExtensionlessCandidates.push({
            entry,
            diskBaseName: base,
            ext,
          });
        }
      }
    }
  }

  // Candidate 3: Case-mismatched directory with index file
  // e.g. requested 'utils', disk has 'Utils/' containing 'index.ts'
  const caseDirCandidates: DirectoryEntry[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.toLowerCase() === lastSegLower) {
      const subEntries = cache.getEntries(path.join(currentDir, entry.name), fs);
      if (subEntries.some((e) => INDEX_FILES.includes(e.name))) {
        caseDirCandidates.push(entry);
      }
    }
  }

  // Evaluate final segment candidates
  if (caseDirectFiles.length === 1) {
    // Explicit extension match with different casing
    const actual = caseDirectFiles[0].name;
    mismatchFound = true;
    correctedSegments.push(actual);
    mismatchDetails.push(`File '${lastSeg}' on disk is '${actual}'`);
    return buildResult(prefix, separator, correctedSegments, hasTrailingSlash, specifier, currentDir, mismatchDetails, isAmbiguous);
  }

  if (caseExtensionlessCandidates.length === 1) {
    // Extensionless match with different casing
    const cand = caseExtensionlessCandidates[0];
    mismatchFound = true;
    correctedSegments.push(cand.diskBaseName);
    mismatchDetails.push(`File '${lastSeg}' on disk is '${cand.entry.name}'`);
    return buildResult(prefix, separator, correctedSegments, hasTrailingSlash, specifier, currentDir, mismatchDetails, isAmbiguous);
  }

  if (caseDirCandidates.length === 1) {
    // Directory match with different casing
    const actualDir = caseDirCandidates[0].name;
    mismatchFound = true;
    correctedSegments.push(actualDir);
    mismatchDetails.push(`Directory '${lastSeg}' on disk is '${actualDir}'`);
    return buildResult(prefix, separator, correctedSegments, hasTrailingSlash, specifier, currentDir, mismatchDetails, isAmbiguous);
  }

  // Multiple candidates (ambiguous)
  const totalCandidates = caseDirectFiles.length + caseExtensionlessCandidates.length + caseDirCandidates.length;
  if (totalCandidates > 1) {
    mismatchFound = true;
    isAmbiguous = true;
    mismatchDetails.push(`Multiple files or directories match '${lastSeg}' with different casing.`);
    // Pick the first candidate for diagnostic context, but isAmbiguous flag will prevent Quick Fix
    const bestName =
      caseDirectFiles[0]?.name ||
      caseExtensionlessCandidates[0]?.diskBaseName ||
      caseDirCandidates[0]?.name ||
      lastSeg;
    correctedSegments.push(bestName);
    return buildResult(prefix, separator, correctedSegments, hasTrailingSlash, specifier, currentDir, mismatchDetails, isAmbiguous);
  }

  // 0 candidates -> Path genuinely does not exist!
  // Remember: We only flag casing mismatches, not missing files.
  return null;
}

function buildResult(
  prefix: string,
  separator: string,
  correctedSegments: string[],
  hasTrailingSlash: boolean,
  originalSpecifier: string,
  targetDir: string,
  details: string[],
  isAmbiguous: boolean
): CaseMismatchDiagnostic | null {
  let correctedSpecifier = prefix + correctedSegments.join(separator);
  if (hasTrailingSlash && !correctedSpecifier.endsWith(separator)) {
    correctedSpecifier += separator;
  }

  // Safety check: Never emit a mismatch diagnostic when correctedSpecifier === originalSpecifier
  if (correctedSpecifier === originalSpecifier) {
    return null;
  }

  const actualDiskPath = path.join(targetDir, correctedSegments[correctedSegments.length - 1] || '');

  return {
    hasMismatch: true,
    isAmbiguous,
    originalSpecifier,
    correctedSpecifier: isAmbiguous ? undefined : correctedSpecifier,
    actualDiskPath,
    message: isAmbiguous
      ? 'Import path casing does not match the filesystem (ambiguous match on disk).'
      : 'Import path casing does not match the filesystem.',
    details: details.join('; '),
  };
}

function resolveAliasImport(
  importingFilePath: string,
  specifier: string,
  mapping: PathMapping,
  fs: IFileSystem,
  cache: DirectoryCache
): CaseMismatchDiagnostic | null {
  const isWindowsSep = specifier.includes('\\') && !specifier.includes('/');
  const separator = isWindowsSep ? '\\' : '/';
  const hasTrailingSlash = specifier.endsWith('/') || specifier.endsWith('\\');

  // Exact pattern mapping without wildcards (e.g. "@app": ["src/App.tsx"])
  if (!mapping.hasWildcard) {
    if (specifier !== mapping.pattern) {
      return null;
    }
    for (const target of mapping.targets) {
      const targetPath = path.resolve(mapping.baseDir, target);
      if (fs.fileExists(targetPath)) {
        return null; // exact match on disk
      }
      const st = fs.stat(targetPath);
      if (st && st.isDirectory) {
        return null;
      }
    }
    return null;
  }

  if (mapping.suffix && (mapping.suffix.includes('/') || mapping.suffix.includes('\\'))) {
    return null;
  }

  const wildcardValue = specifier.slice(
    mapping.prefix.length,
    specifier.length - (mapping.suffix ? mapping.suffix.length : 0)
  );
  const rawSegments = wildcardValue.split(/[/\\]/).filter((s) => s.length > 0);

  if (rawSegments.length === 0) {
    for (const target of mapping.targets) {
      const starIdx = target.indexOf('*');
      const targetPrefix = starIdx !== -1 ? target.slice(0, starIdx) : target;
      const targetDir = path.resolve(mapping.baseDir, targetPrefix);
      const entries = cache.getEntries(targetDir, fs);
      if (entries.some((e) => INDEX_FILES.includes(e.name))) {
        return null;
      }
    }
    return null;
  }

    // Iterate through ordered fallback targets
    for (const target of mapping.targets) {
      const starIdx = target.indexOf('*');
      if (starIdx === -1) {
        continue;
      }
      if (target.indexOf('*') !== target.lastIndexOf('*')) {
        continue;
      }

      const targetPrefix = target.slice(0, starIdx);
      const targetSuffix = target.slice(starIdx + 1);

      if (targetSuffix.includes('/') || targetSuffix.includes('\\')) {
        continue;
      }

      let currentDir = path.resolve(mapping.baseDir, targetPrefix);

      const baseStat = fs.stat(currentDir);
      if (!baseStat || !baseStat.isDirectory) {
        continue;
      }

      const correctedSegments: string[] = [];
      let mismatchFound = false;
      let isAmbiguous = false;
      const mismatchDetails: string[] = [];
      let targetValid = true;

      // 1. Process intermediate directory segments
      for (let i = 0; i < rawSegments.length - 1; i++) {
        const seg = rawSegments[i];
        const entries = cache.getEntries(currentDir, fs);

        const exactMatch = entries.find((e) => e.name === seg && e.isDirectory());
        if (exactMatch) {
          correctedSegments.push(seg);
          currentDir = path.join(currentDir, seg);
          continue;
        }

        const segLower = seg.toLowerCase();
        const caseMatches = entries.filter(
          (e) => e.name.toLowerCase() === segLower && e.isDirectory()
        );

        if (caseMatches.length === 0) {
          targetValid = false;
          break;
        }

        if (caseMatches.length > 1) {
          isAmbiguous = true;
          mismatchFound = true;
          correctedSegments.push(caseMatches[0].name);
          mismatchDetails.push(`Directory segment '${seg}' has multiple ambiguous matches on disk.`);
          currentDir = path.join(currentDir, caseMatches[0].name);
          continue;
        }

        const actualDirName = caseMatches[0].name;
        mismatchFound = true;
        correctedSegments.push(actualDirName);
        mismatchDetails.push(`Directory segment '${seg}' on disk is '${actualDirName}'`);
        currentDir = path.join(currentDir, actualDirName);
      }

      if (!targetValid) {
        continue;
      }

      // 2. Process final segment
      const lastSeg = rawSegments[rawSegments.length - 1];
      const entries = cache.getEntries(currentDir, fs);

      const expectedTargetBase = lastSeg + targetSuffix;
      const expectedTargetBaseLower = expectedTargetBase.toLowerCase();

      // Check exact direct file
      const exactDirectFile = entries.find((e) => e.name === expectedTargetBase && e.isFile());
      if (exactDirectFile) {
        correctedSegments.push(lastSeg);
        if (mismatchFound) {
          return buildAliasResult(
            mapping,
            separator,
            correctedSegments,
            hasTrailingSlash,
            specifier,
            currentDir,
            mismatchDetails,
            isAmbiguous,
            targetSuffix
          );
        }
        return null; // exact match across path
      }

      // Check exact extensionless file
      let exactExtMatch: DirectoryEntry | null = null;
      for (const ext of SUPPORTED_SOURCE_EXTENSIONS) {
        const candidate = entries.find((e) => e.name === expectedTargetBase + ext && e.isFile());
        if (candidate) {
          exactExtMatch = candidate;
          break;
        }
      }
      if (exactExtMatch) {
        correctedSegments.push(lastSeg);
        if (mismatchFound) {
          return buildAliasResult(
            mapping,
            separator,
            correctedSegments,
            hasTrailingSlash,
            specifier,
            currentDir,
            mismatchDetails,
            isAmbiguous,
            targetSuffix
          );
        }
        return null; // exact match
      }

      // Check exact directory with index file
      const exactDir = entries.find((e) => e.name === expectedTargetBase && e.isDirectory());
      if (exactDir) {
        const subEntries = cache.getEntries(path.join(currentDir, exactDir.name), fs);
        const hasIndex = subEntries.some((e) => INDEX_FILES.includes(e.name));
        if (hasIndex) {
          correctedSegments.push(lastSeg);
          if (mismatchFound) {
            return buildAliasResult(
              mapping,
              separator,
              correctedSegments,
              hasTrailingSlash,
              specifier,
              currentDir,
              mismatchDetails,
              isAmbiguous,
              targetSuffix
            );
          }
          return null; // exact match
        }
      }

      // No exact match: check case-insensitive candidates on the final segment
      interface AliasCandidate {
        actualStem: string;
        actualDiskName: string;
        type: 'direct' | 'extensionless' | 'dir';
      }

      const caseDirectCandidates: AliasCandidate[] = [];
      const caseExtensionlessCandidates: AliasCandidate[] = [];
      const caseDirCandidates: AliasCandidate[] = [];

      for (const entry of entries) {
        if (entry.isFile()) {
          // Direct file check
          if (entry.name.toLowerCase() === expectedTargetBaseLower) {
            const actualStem = targetSuffix.length > 0
              ? entry.name.slice(0, entry.name.length - targetSuffix.length)
              : entry.name;
            caseDirectCandidates.push({
              actualStem,
              actualDiskName: entry.name,
              type: 'direct',
            });
          }

          // Extensionless file check
          for (const ext of SUPPORTED_SOURCE_EXTENSIONS) {
            if (entry.name.toLowerCase().endsWith(ext.toLowerCase())) {
              const base = entry.name.slice(0, entry.name.length - ext.length);
              if (base.toLowerCase() === expectedTargetBaseLower) {
                const actualStem = targetSuffix.length > 0
                  ? base.slice(0, base.length - targetSuffix.length)
                  : base;
                caseExtensionlessCandidates.push({
                  actualStem,
                  actualDiskName: entry.name,
                  type: 'extensionless',
                });
                break;
              }
            }
          }
        } else if (entry.isDirectory()) {
          // Directory with index check
          if (entry.name.toLowerCase() === expectedTargetBaseLower) {
            const subEntries = cache.getEntries(path.join(currentDir, entry.name), fs);
            if (subEntries.some((e) => INDEX_FILES.includes(e.name))) {
              const actualStem = targetSuffix.length > 0
                ? entry.name.slice(0, entry.name.length - targetSuffix.length)
                : entry.name;
              caseDirCandidates.push({
                actualStem,
                actualDiskName: entry.name,
                type: 'dir',
              });
            }
          }
        }
      }

      const allCandidates = [
        ...caseDirectCandidates,
        ...caseExtensionlessCandidates,
        ...caseDirCandidates,
      ];

      if (allCandidates.length === 1) {
        const cand = allCandidates[0];
        mismatchFound = true;
        correctedSegments.push(cand.actualStem);
        const itemType = cand.type === 'dir' ? 'Directory' : 'File';
        const displayItem = targetSuffix.length > 0 ? expectedTargetBase : lastSeg;
        mismatchDetails.push(`${itemType} '${displayItem}' on disk is '${cand.actualDiskName}'`);
        return buildAliasResult(
          mapping,
          separator,
          correctedSegments,
          hasTrailingSlash,
          specifier,
          currentDir,
          mismatchDetails,
          isAmbiguous,
          targetSuffix
        );
      }

      if (allCandidates.length > 1) {
        mismatchFound = true;
        isAmbiguous = true;
        mismatchDetails.push(`Multiple files or directories match '${lastSeg}' with different casing.`);
        const bestCand = allCandidates[0];
        correctedSegments.push(bestCand ? bestCand.actualStem : lastSeg);
        return buildAliasResult(
          mapping,
          separator,
          correctedSegments,
          hasTrailingSlash,
          specifier,
          currentDir,
          mismatchDetails,
          isAmbiguous,
          targetSuffix
        );
      }

      // 0 candidates -> this target does not exist, continue loop to next ordered fallback target
    }

  return null;
}

function buildAliasResult(
  mapping: PathMapping,
  separator: string,
  correctedSegments: string[],
  hasTrailingSlash: boolean,
  originalSpecifier: string,
  targetDir: string,
  details: string[],
  isAmbiguous: boolean,
  targetSuffix?: string
): CaseMismatchDiagnostic | null {
  const correctedWildcard = correctedSegments.join(separator);
  let correctedSpecifier = mapping.prefix + correctedWildcard + (mapping.suffix || '');
  if (hasTrailingSlash && !correctedSpecifier.endsWith(separator)) {
    correctedSpecifier += separator;
  }

  if (correctedSpecifier === originalSpecifier) {
    return null;
  }

  const finalSegment = correctedSegments[correctedSegments.length - 1] || '';
  const diskSegment = targetSuffix ? finalSegment + targetSuffix : finalSegment;
  const actualDiskPath = path.join(targetDir, diskSegment);

  return {
    hasMismatch: true,
    isAmbiguous,
    originalSpecifier,
    correctedSpecifier: isAmbiguous ? undefined : correctedSpecifier,
    actualDiskPath,
    matchedPattern: mapping.pattern,
    message: isAmbiguous
      ? 'Import path casing does not match the filesystem (ambiguous match on disk).'
      : 'Import path casing does not match the filesystem.',
    details: details.join('; '),
  };
}
