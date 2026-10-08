import { TextPosition, TextRange } from './types';

export enum TokenType {
  KEYWORD = 'KEYWORD',
  IDENTIFIER = 'IDENTIFIER',
  STRING = 'STRING',
  TEMPLATE_STATIC = 'TEMPLATE_STATIC',
  TEMPLATE_HEAD = 'TEMPLATE_HEAD',
  TEMPLATE_MIDDLE = 'TEMPLATE_MIDDLE',
  TEMPLATE_TAIL = 'TEMPLATE_TAIL',
  PUNCTUATOR = 'PUNCTUATOR',
  REGEX = 'REGEX',
  EOF = 'EOF',
}

export interface Token {
  type: TokenType;
  value: string;
  startOffset: number;
  endOffset: number;
  contentStartOffset: number; // for strings: inside quotes
  contentEndOffset: number; // for strings: inside quotes
  range: TextRange;
  contentRange: TextRange;
  quote?: "'" | '"' | '`';
}

const KEYWORDS = new Set([
  'import',
  'export',
  'from',
  'require',
  'type',
  'as',
  'default',
]);

export function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  const len = source.length;
  let idx = 0;
  let line = 0;
  let character = 0;

  // Track template literal state
  // When inside a template interpolation ${ ... }, we need to know when matching '}' ends it
  const templateBraceStack: number[] = [];
  let braceDepth = 0;

  function getPos(): TextPosition {
    return { line, character };
  }

  function advance(): string {
    const ch = source[idx++];
    if (ch === '\n') {
      line++;
      character = 0;
    } else if (ch === '\r') {
      if (idx < len && source[idx] === '\n') {
        // CRLF
        idx++;
      }
      line++;
      character = 0;
    } else {
      character++;
    }
    return ch;
  }

  function peek(offset = 0): string {
    return idx + offset < len ? source[idx + offset] : '';
  }

  while (idx < len) {
    const ch = peek();

    // Check if we are at the end of a template interpolation
    if (
      ch === '}' &&
      templateBraceStack.length > 0 &&
      braceDepth === templateBraceStack[templateBraceStack.length - 1]
    ) {
      templateBraceStack.pop();
      advance(); // consume '}'
      // Now scan template middle or tail
      scanTemplateContinuation();
      continue;
    }

    // 1. Whitespace
    if (/\s/.test(ch)) {
      advance();
      continue;
    }

    // 2. Comments
    if (ch === '/' && peek(1) === '/') {
      // Single-line comment
      advance();
      advance();
      while (idx < len && peek() !== '\n' && peek() !== '\r') {
        advance();
      }
      continue;
    }

    if (ch === '/' && peek(1) === '*') {
      // Multi-line comment
      advance();
      advance();
      while (idx < len) {
        if (peek() === '*' && peek(1) === '/') {
          advance();
          advance();
          break;
        }
        advance();
      }
      continue;
    }

    // 2.5 Regular expression literals (vs division operator)
    if (ch === '/') {
      const prevToken = tokens.length > 0 ? tokens[tokens.length - 1] : undefined;
      if (canRegexFollow(prevToken)) {
        if (scanRegex()) {
          continue;
        }
      }
    }

    // 3. String literals (single or double quote)
    if (ch === "'" || ch === '"') {
      scanString(ch);
      continue;
    }

    // 4. Template literals
    if (ch === '`') {
      scanTemplateStart();
      continue;
    }

    // 5. Identifiers and Keywords
    if (/[a-zA-Z_$]/.test(ch)) {
      scanIdentifier();
      continue;
    }

    // 6. Punctuators
    const startOffset = idx;
    const startPos = getPos();

    if (ch === '{') {
      braceDepth++;
      advance();
    } else if (ch === '}') {
      if (braceDepth > 0) {
        braceDepth--;
      }
      advance();
    } else if (
      ch === '(' ||
      ch === ')' ||
      ch === '[' ||
      ch === ']' ||
      ch === ';' ||
      ch === ',' ||
      ch === '*' ||
      ch === '.' ||
      ch === ':'
    ) {
      advance();
    } else {
      // Any other operator or punctuation
      advance();
    }

    const endOffset = idx;
    const endPos = getPos();
    const val = source.slice(startOffset, endOffset);

    tokens.push({
      type: TokenType.PUNCTUATOR,
      value: val,
      startOffset,
      endOffset,
      contentStartOffset: startOffset,
      contentEndOffset: endOffset,
      range: { start: startPos, end: endPos },
      contentRange: { start: startPos, end: endPos },
    });
  }

  function scanString(quoteChar: "'" | '"') {
    const startOffset = idx;
    const startPos = getPos();

    advance(); // consume opening quote
    const contentStartOffset = idx;
    const contentStartPos = getPos();

    let value = '';
    let closed = false;

    while (idx < len) {
      const c = peek();
      if (c === quoteChar) {
        advance(); // consume closing quote
        closed = true;
        break;
      }
      if (c === '\n' || c === '\r') {
        // Unterminated string literal on new line
        break;
      }
      if (c === '\\') {
        advance(); // consume backslash
        if (idx < len) {
          const next = advance();
          value += next; // unescape single char
        }
      } else {
        value += advance();
      }
    }

    const contentEndOffset = closed ? idx - 1 : idx;
    // Calculate content end position
    const endOffset = idx;
    const endPos = getPos();

    // End position of content
    let contentEndPos = endPos;
    if (closed) {
      // 1 char before closing quote
      contentEndPos = {
        line: endPos.line,
        character: Math.max(0, endPos.character - 1),
      };
    }

    tokens.push({
      type: TokenType.STRING,
      value,
      quote: quoteChar,
      startOffset,
      endOffset,
      contentStartOffset,
      contentEndOffset,
      range: { start: startPos, end: endPos },
      contentRange: { start: contentStartPos, end: contentEndPos },
    });
  }

  function scanTemplateStart() {
    const startOffset = idx;
    const startPos = getPos();

    advance(); // consume opening `
    const contentStartOffset = idx;
    const contentStartPos = getPos();

    let value = '';
    let hasInterpolation = false;

    while (idx < len) {
      const c = peek();
      if (c === '`') {
        advance(); // consume closing `
        const contentEndOffset = idx - 1;
        const endOffset = idx;
        const endPos = getPos();
        const contentEndPos = {
          line: endPos.line,
          character: Math.max(0, endPos.character - 1),
        };

        tokens.push({
          type: TokenType.TEMPLATE_STATIC,
          value,
          quote: '`',
          startOffset,
          endOffset,
          contentStartOffset,
          contentEndOffset,
          range: { start: startPos, end: endPos },
          contentRange: { start: contentStartPos, end: contentEndPos },
        });
        return;
      }

      if (c === '$' && peek(1) === '{') {
        hasInterpolation = true;
        advance(); // consume $
        advance(); // consume {
        templateBraceStack.push(braceDepth);

        const endOffset = idx;
        const endPos = getPos();

        tokens.push({
          type: TokenType.TEMPLATE_HEAD,
          value,
          quote: '`',
          startOffset,
          endOffset,
          contentStartOffset,
          contentEndOffset: idx - 2,
          range: { start: startPos, end: endPos },
          contentRange: { start: contentStartPos, end: getPos() },
        });
        return;
      }

      if (c === '\\') {
        advance(); // consume backslash
        if (idx < len) {
          value += advance();
        }
      } else {
        value += advance();
      }
    }

    // Unterminated template
    tokens.push({
      type: TokenType.TEMPLATE_STATIC,
      value,
      quote: '`',
      startOffset,
      endOffset: idx,
      contentStartOffset,
      contentEndOffset: idx,
      range: { start: startPos, end: getPos() },
      contentRange: { start: contentStartPos, end: getPos() },
    });
  }

  function scanTemplateContinuation() {
    const startOffset = idx;
    const startPos = getPos();
    let value = '';

    while (idx < len) {
      const c = peek();
      if (c === '`') {
        advance(); // consume closing `
        const endOffset = idx;
        const endPos = getPos();

        tokens.push({
          type: TokenType.TEMPLATE_TAIL,
          value,
          quote: '`',
          startOffset,
          endOffset,
          contentStartOffset: startOffset,
          contentEndOffset: endOffset - 1,
          range: { start: startPos, end: endPos },
          contentRange: {
            start: startPos,
            end: { line: endPos.line, character: Math.max(0, endPos.character - 1) },
          },
        });
        return;
      }

      if (c === '$' && peek(1) === '{') {
        advance(); // consume $
        advance(); // consume {
        templateBraceStack.push(braceDepth);

        const endOffset = idx;
        const endPos = getPos();

        tokens.push({
          type: TokenType.TEMPLATE_MIDDLE,
          value,
          quote: '`',
          startOffset,
          endOffset,
          contentStartOffset: startOffset,
          contentEndOffset: endOffset - 2,
          range: { start: startPos, end: endPos },
          contentRange: { start: startPos, end: endPos },
        });
        return;
      }

      if (c === '\\') {
        advance();
        if (idx < len) {
          value += advance();
        }
      } else {
        value += advance();
      }
    }
  }

  function canRegexFollow(prev: Token | undefined): boolean {
    if (!prev) return true;
    if (prev.type === TokenType.KEYWORD) {
      return (
        prev.value === 'return' ||
        prev.value === 'case' ||
        prev.value === 'default' ||
        prev.value === 'throw' ||
        prev.value === 'yield' ||
        prev.value === 'await' ||
        prev.value === 'typeof' ||
        prev.value === 'void' ||
        prev.value === 'delete' ||
        prev.value === 'instanceof' ||
        prev.value === 'in' ||
        prev.value === 'of'
      );
    }
    if (prev.type === TokenType.PUNCTUATOR) {
      // Any punctuator except ) and ] which conclude expressions/operands
      return prev.value !== ')' && prev.value !== ']';
    }
    return false;
  }

  function scanRegex(): boolean {
    const startOffset = idx;
    const startPos = getPos();

    advance(); // consume opening '/'
    let inCharClass = false;
    let closed = false;

    while (idx < len) {
      const c = peek();
      if (c === '\n' || c === '\r') {
        break; // regex literal cannot span raw unescaped newlines
      }
      if (c === '\\') {
        advance(); // consume backslash
        if (idx < len) {
          advance(); // consume escaped char
        }
        continue;
      }
      if (c === '[') {
        inCharClass = true;
        advance();
        continue;
      }
      if (c === ']' && inCharClass) {
        inCharClass = false;
        advance();
        continue;
      }
      if (c === '/' && !inCharClass) {
        advance(); // consume closing '/'
        closed = true;
        break;
      }
      advance();
    }

    if (!closed) {
      // Revert if not closed properly on the same line
      idx = startOffset;
      line = startPos.line;
      character = startPos.character;
      return false;
    }

    // Consume flags (e.g. gimsuy)
    while (idx < len && /[a-zA-Z]/.test(peek())) {
      advance();
    }

    const endOffset = idx;
    const endPos = getPos();
    const val = source.slice(startOffset, endOffset);

    tokens.push({
      type: TokenType.REGEX,
      value: val,
      startOffset,
      endOffset,
      contentStartOffset: startOffset,
      contentEndOffset: endOffset,
      range: { start: startPos, end: endPos },
      contentRange: { start: startPos, end: endPos },
    });
    return true;
  }

  function scanIdentifier() {
    const startOffset = idx;
    const startPos = getPos();

    while (idx < len && /[a-zA-Z0-9_$]/.test(peek())) {
      advance();
    }

    const endOffset = idx;
    const endPos = getPos();
    const val = source.slice(startOffset, endOffset);
    const isKeyword = KEYWORDS.has(val);

    tokens.push({
      type: isKeyword ? TokenType.KEYWORD : TokenType.IDENTIFIER,
      value: val,
      startOffset,
      endOffset,
      contentStartOffset: startOffset,
      contentEndOffset: endOffset,
      range: { start: startPos, end: endPos },
      contentRange: { start: startPos, end: endPos },
    });
  }

  return tokens;
}
