export type ImportKind =
  | 'static-import'
  | 'side-effect'
  | 'type-import'
  | 'export-from'
  | 'require'
  | 'dynamic-import';

export interface TextPosition {
  line: number; // 0-based
  character: number; // 0-based
}

export interface TextRange {
  start: TextPosition;
  end: TextPosition;
}

export interface ImportSpecifier {
  rawSpecifier: string;
  quote: "'" | '"' | '`';
  startOffset: number; // Start offset of the specifier content (excluding quotes)
  endOffset: number; // End offset of the specifier content (excluding quotes)
  range: TextRange; // Position of the specifier content (excluding quotes)
  fullLiteralStart: number; // Start offset including opening quote
  fullLiteralEnd: number; // End offset including closing quote
  fullLiteralRange: TextRange; // Range including quotes
  kind: ImportKind;
}
