import { ImportKind, ImportSpecifier } from './types';
import { tokenize, Token, TokenType } from './tokenizer';

/**
 * Checks whether an import specifier is a local relative import.
 * Only paths starting with '.' (e.g. './', '../', '.\\', '..\\') are local relative.
 */
export function isLocalRelativeImport(specifier: string): boolean {
  if (!specifier || typeof specifier !== 'string') {
    return false;
  }
  // Must start with '.' and be followed by '/' or '\\' or another '.'
  return (
    specifier.startsWith('./') ||
    specifier.startsWith('../') ||
    specifier.startsWith('.\\') ||
    specifier.startsWith('..\\') ||
    specifier === '.' ||
    specifier === '..'
  );
}

export const MAX_FILE_SIZE_BYTES = 1024 * 1024; // 1 MB
export const MAX_FILE_LINES = 50000;

export interface ScanOptions {
  /** If true, returns all static import specifiers (including non-relative / aliased). */
  includeNonRelative?: boolean;
}

/**
 * Scans JavaScript / TypeScript source code to detect import specifiers.
 * By default returns local relative imports. Set options.includeNonRelative to true
 * to also include candidate alias imports.
 * Ignores comments, unrelated strings, and non-static expressions.
 */
export function scanImports(source: string, options?: ScanOptions): ImportSpecifier[] {
  if (!source || source.length > MAX_FILE_SIZE_BYTES) {
    return [];
  }

  const includeNonRelative = options?.includeNonRelative ?? false;

  const tokens = tokenize(source);
  const imports: ImportSpecifier[] = [];
  const len = tokens.length;

  for (let i = 0; i < len; i++) {
    const token = tokens[i];

    // Case 1 & 2: 'import' keyword
    if (token.type === TokenType.KEYWORD && token.value === 'import') {
      // Check if preceded by a dot (e.g. obj.import) -> not an import statement
      if (i > 0 && tokens[i - 1].type === TokenType.PUNCTUATOR && tokens[i - 1].value === '.') {
        continue;
      }

      // Check for dynamic import: import('...')
      if (i + 1 < len && tokens[i + 1].type === TokenType.PUNCTUATOR && tokens[i + 1].value === '(') {
        // dynamic import(...)
        const next = tokens[i + 2];
        if (next && isStaticStringToken(next)) {
          // Verify it's followed by ')' or ',' (e.g. import('./foo') or import('./foo', { with: ... }))
          const afterStr = tokens[i + 3];
          if (afterStr && (afterStr.value === ')' || afterStr.value === ',')) {
            addIfRelative(imports, next, 'dynamic-import', includeNonRelative);
          }
        }
        continue;
      }

      // Check for side-effect import: import '...'
      if (i + 1 < len && isStaticStringToken(tokens[i + 1])) {
        addIfRelative(imports, tokens[i + 1], 'side-effect', includeNonRelative);
        i++; // advance past string
        continue;
      }

      // Static import with 'from': import ... from '...'
      // Scan forward looking for 'from' outside named binding braces { ... }
      let searchIdx = i + 1;
      let importBraceDepth = 0;

      while (searchIdx < len) {
        const t = tokens[searchIdx];
        if (t.type === TokenType.PUNCTUATOR && t.value === '{') {
          importBraceDepth++;
        } else if (t.type === TokenType.PUNCTUATOR && t.value === '}') {
          if (importBraceDepth > 0) importBraceDepth--;
        }

        if (importBraceDepth === 0 && t.type === TokenType.PUNCTUATOR && t.value === ';') {
          break;
        }
        // If we hit another statement keyword at top level without finding 'from', break
        if (
          importBraceDepth === 0 &&
          t.type === TokenType.KEYWORD &&
          (t.value === 'import' || t.value === 'export' || t.value === 'const' || t.value === 'let' || t.value === 'var')
        ) {
          break;
        }

        // Only match 'from' when outside { ... } braces (e.g. import { from } from "./A")
        if (importBraceDepth === 0 && t.type === TokenType.KEYWORD && t.value === 'from') {
          const strToken = tokens[searchIdx + 1];
          if (strToken && isStaticStringToken(strToken)) {
            // Determine kind: type import or static import
            const isType = tokens.slice(i, searchIdx).some(
              (tok) => tok.type === TokenType.KEYWORD && tok.value === 'type'
            );
            addIfRelative(imports, strToken, isType ? 'type-import' : 'static-import', includeNonRelative);
            i = searchIdx + 1;
          }
          break;
        }
        searchIdx++;
      }
      continue;
    }

    // Case 3: 'export' keyword ... from '...'
    if (token.type === TokenType.KEYWORD && token.value === 'export') {
      if (i > 0 && tokens[i - 1].type === TokenType.PUNCTUATOR && tokens[i - 1].value === '.') {
        continue;
      }

      let searchIdx = i + 1;
      let exportBraceDepth = 0;

      while (searchIdx < len) {
        const t = tokens[searchIdx];
        if (t.type === TokenType.PUNCTUATOR && t.value === '{') {
          exportBraceDepth++;
        } else if (t.type === TokenType.PUNCTUATOR && t.value === '}') {
          if (exportBraceDepth > 0) exportBraceDepth--;
        }

        if (exportBraceDepth === 0 && t.type === TokenType.PUNCTUATOR && t.value === ';') {
          break;
        }
        if (
          exportBraceDepth === 0 &&
          t.type === TokenType.KEYWORD &&
          (t.value === 'import' || t.value === 'export' || t.value === 'const' || t.value === 'let' || t.value === 'var')
        ) {
          break;
        }
        if (exportBraceDepth === 0 && t.type === TokenType.KEYWORD && t.value === 'from') {
          const strToken = tokens[searchIdx + 1];
          if (strToken && isStaticStringToken(strToken)) {
            addIfRelative(imports, strToken, 'export-from', includeNonRelative);
            i = searchIdx + 1;
          }
          break;
        }
        searchIdx++;
      }
      continue;
    }

    // Case 4: require('...')
    if (
      (token.type === TokenType.KEYWORD || token.type === TokenType.IDENTIFIER) &&
      token.value === 'require'
    ) {
      // Must not be preceded by a dot (e.g. foo.require)
      if (i > 0 && tokens[i - 1].type === TokenType.PUNCTUATOR && tokens[i - 1].value === '.') {
        continue;
      }

      if (i + 1 < len && tokens[i + 1].type === TokenType.PUNCTUATOR && tokens[i + 1].value === '(') {
        const argToken = tokens[i + 2];
        if (argToken && isStaticStringToken(argToken)) {
          const closing = tokens[i + 3];
          if (closing && (closing.value === ')' || closing.value === ',')) {
            addIfRelative(imports, argToken, 'require', includeNonRelative);
          }
        }
      }
      continue;
    }
  }

  return imports;
}

function isStaticStringToken(token: Token): boolean {
  return token.type === TokenType.STRING || token.type === TokenType.TEMPLATE_STATIC;
}

function addIfRelative(list: ImportSpecifier[], token: Token, kind: ImportKind, includeNonRelative = false) {
  const specifier = token.value;
  if (!includeNonRelative && !isLocalRelativeImport(specifier)) {
    return;
  }

  list.push({
    rawSpecifier: specifier,
    quote: token.quote || "'",
    startOffset: token.contentStartOffset,
    endOffset: token.contentEndOffset,
    range: token.contentRange,
    fullLiteralStart: token.startOffset,
    fullLiteralEnd: token.endOffset,
    fullLiteralRange: token.range,
    kind,
  });
}
