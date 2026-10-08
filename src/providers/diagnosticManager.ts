import * as vscode from 'vscode';
import { scanImports } from '../scanner/importScanner';
import { ImportSpecifier } from '../scanner/types';
import { resolveAndValidateImport, CaseMismatchDiagnostic } from '../resolver/pathResolver';
import { IFileSystem, NodeFileSystem, getTextAtRange } from '../resolver/fileSystem';
import { DirectoryCache } from '../resolver/cache';
import { isPathExcluded, ExtensionConfig } from '../config';

import * as path from 'path';
import { parseRelativeSpecifier } from '../resolver/pathResolver';

export const DIAGNOSTIC_SOURCE = 'Import Case Guard';
export const DIAGNOSTIC_CODE = 'import-case-guard.case-mismatch';

export interface FileMismatchData {
  range: vscode.Range;
  importSpecifier: ImportSpecifier;
  diagnostic: CaseMismatchDiagnostic;
}

export const SUPPORTED_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];

/**
 * Recursively discovers all supported JavaScript/TypeScript source files in a workspace folder,
 * strictly pruning excluded directories (node_modules, dist, .git, etc.) to keep scanning fast.
 */
export function findWorkspaceFiles(
  rootPath: string,
  config: ExtensionConfig,
  fs: IFileSystem
): string[] {
  const result: string[] = [];
  const supportedExts = new Set(SUPPORTED_EXTENSIONS);

  function walk(currentDir: string) {
    if (isPathExcluded(currentDir, config.exclude, rootPath)) {
      return;
    }

    const entries = fs.readDir(currentDir);
    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        if (!isPathExcluded(fullPath, config.exclude, rootPath)) {
          walk(fullPath);
        }
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (supportedExts.has(ext)) {
          if (!isPathExcluded(fullPath, config.exclude, rootPath)) {
            result.push(fullPath);
          }
        }
      }
    }
  }

  walk(rootPath);
  return result;
}

export class DiagnosticManager {
  private collection: vscode.DiagnosticCollection;
  private mismatchMap: Map<string, FileMismatchData[]> = new Map();
  private documentDependencies: Map<string, Set<string>> = new Map();
  private fs: IFileSystem;
  private cache: DirectoryCache;

  constructor(collection: vscode.DiagnosticCollection, fs?: IFileSystem, cache?: DirectoryCache) {
    this.collection = collection;
    this.fs = fs || new NodeFileSystem();
    this.cache = cache || new DirectoryCache();
  }

  getFileSystem(): IFileSystem {
    return this.fs;
  }

  getCache(): DirectoryCache {
    return this.cache;
  }

  getMismatchesForDocument(uri: vscode.Uri): FileMismatchData[] {
    return this.mismatchMap.get(uri.toString()) || [];
  }

  findMismatchAtPosition(uri: vscode.Uri, position: vscode.Position): FileMismatchData | undefined {
    const list = this.getMismatchesForDocument(uri);
    return list.find((m) => m.range.contains(position));
  }

  findMismatchForDiagnostic(uri: vscode.Uri, diagnostic: vscode.Diagnostic): FileMismatchData | undefined {
    const list = this.getMismatchesForDocument(uri);
    return list.find((m) => m.range.isEqual(diagnostic.range));
  }

  isDocumentAffectedByDir(docUri: vscode.Uri, changedDir: string): boolean {
    const normChanged = path.normalize(changedDir);
    const docDir = path.dirname(path.normalize(docUri.fsPath));
    if (isSameOrSubdirectory(normChanged, docDir)) {
      return true;
    }
    const deps = this.documentDependencies.get(docUri.toString());
    if (deps) {
      for (const dep of deps) {
        if (isSameOrSubdirectory(normChanged, dep)) {
          return true;
        }
      }
    }
    return false;
  }

  clearDocument(uri: vscode.Uri): void {
    this.collection.delete(uri);
    this.mismatchMap.delete(uri.toString());
    this.documentDependencies.delete(uri.toString());
  }

  clearAll(): void {
    this.collection.clear();
    this.mismatchMap.clear();
    this.documentDependencies.clear();
    this.cache.clear();
  }

  scanFile(
    filePath: string,
    config: ExtensionConfig,
    workspaceRoot?: string,
    customText?: string
  ): FileMismatchData[] {
    const uri = vscode.Uri.file(filePath);

    // Only process file scheme
    if (uri.scheme !== 'file') {
      this.clearDocument(uri);
      return [];
    }

    // Check if extension is enabled
    if (!config.enable) {
      this.clearDocument(uri);
      return [];
    }

    // Check if path is excluded (evaluating workspace-relative path if available)
    const wsFolder = workspaceRoot ?? vscode.workspace.getWorkspaceFolder?.(uri)?.uri.fsPath;
    if (isPathExcluded(filePath, config.exclude, wsFolder)) {
      this.clearDocument(uri);
      return [];
    }

    // Check supported file extension
    const ext = path.extname(filePath).toLowerCase();
    if (!SUPPORTED_EXTENSIONS.includes(ext)) {
      this.clearDocument(uri);
      return [];
    }

    let text: string | null = customText ?? null;
    if (text === null) {
      const openDoc = vscode.workspace.textDocuments?.find(
        (d) => d.uri.scheme === 'file' && d.uri.fsPath === filePath
      );
      if (openDoc) {
        text = openDoc.getText();
      } else {
        text = this.fs.readFile(filePath);
      }
    }

    if (text === null) {
      return [];
    }

    const imports = scanImports(text);
    const vscodeDiagnostics: vscode.Diagnostic[] = [];
    const mismatches: FileMismatchData[] = [];
    const deps = new Set<string>();
    const docDir = path.dirname(path.normalize(filePath));

    for (const imp of imports) {
      // Record directory dependencies for targeted watcher rescans
      const parsed = parseRelativeSpecifier(imp.rawSpecifier);
      if (parsed) {
        const normPrefix = parsed.prefix.replace(/\\/g, '/');
        const baseDir = path.resolve(docDir, normPrefix);
        if (parsed.segments.length > 1) {
          const parentOfTarget = path.resolve(baseDir, ...parsed.segments.slice(0, -1));
          deps.add(path.normalize(parentOfTarget));
          const fullPath = path.resolve(baseDir, ...parsed.segments);
          deps.add(path.normalize(fullPath));
        } else if (parsed.segments.length === 1) {
          deps.add(path.normalize(baseDir));
          const fullPath = path.resolve(baseDir, parsed.segments[0]);
          deps.add(path.normalize(fullPath));
        } else {
          deps.add(path.normalize(baseDir));
        }
      }

      const result = resolveAndValidateImport(filePath, imp.rawSpecifier, this.fs, this.cache);
      if (!result || !result.hasMismatch) {
        continue;
      }

      // Range is the string specifier content inside quotes
      const range = new vscode.Range(
        new vscode.Position(imp.range.start.line, imp.range.start.character),
        new vscode.Position(imp.range.end.line, imp.range.end.character)
      );

      const diag = new vscode.Diagnostic(
        range,
        result.message,
        vscode.DiagnosticSeverity.Warning
      );
      diag.source = DIAGNOSTIC_SOURCE;
      diag.code = DIAGNOSTIC_CODE;

      vscodeDiagnostics.push(diag);
      mismatches.push({
        range,
        importSpecifier: imp,
        diagnostic: result,
      });
    }

    this.documentDependencies.set(uri.toString(), deps);
    this.mismatchMap.set(uri.toString(), mismatches);
    this.collection.set(uri, vscodeDiagnostics);
    return mismatches;
  }

  scanDocument(document: vscode.TextDocument, config: ExtensionConfig): FileMismatchData[] {
    const uri = document.uri;

    // Only process file scheme
    if (uri.scheme !== 'file') {
      this.clearDocument(uri);
      return [];
    }

    // Check supported language
    const supportedLanguages = ['javascript', 'javascriptreact', 'typescript', 'typescriptreact'];
    if (!supportedLanguages.includes(document.languageId)) {
      this.clearDocument(uri);
      return [];
    }

    const wsFolder = vscode.workspace.getWorkspaceFolder?.(uri)?.uri.fsPath;
    return this.scanFile(uri.fsPath, config, wsFolder, document.getText());
  }

  scanWorkspace(
    workspaceRoots: string[],
    config: ExtensionConfig
  ): { scannedFileCount: number; mismatchCount: number } {
    if (!config.enable || !workspaceRoots || workspaceRoots.length === 0) {
      return { scannedFileCount: 0, mismatchCount: 0 };
    }

    let scannedFileCount = 0;
    let mismatchCount = 0;

    for (const root of workspaceRoots) {
      const files = findWorkspaceFiles(root, config, this.fs);
      for (const file of files) {
        scannedFileCount++;
        const mismatches = this.scanFile(file, config, root);
        mismatchCount += mismatches.length;
      }
    }

    return { scannedFileCount, mismatchCount };
  }

  getFixableMismatchesForDocument(uri: vscode.Uri): FileMismatchData[] {
    const list = this.getMismatchesForDocument(uri);
    return list.filter(
      (m) =>
        !m.diagnostic.isAmbiguous &&
        !!m.diagnostic.correctedSpecifier &&
        m.diagnostic.correctedSpecifier !== m.diagnostic.originalSpecifier
    );
  }

  getAllFixableMismatchesInWorkspace(): Map<string, FileMismatchData[]> {
    const result = new Map<string, FileMismatchData[]>();
    for (const [uriStr, mismatches] of this.mismatchMap.entries()) {
      const fixable = mismatches.filter(
        (m) =>
          !m.diagnostic.isAmbiguous &&
          !!m.diagnostic.correctedSpecifier &&
          m.diagnostic.correctedSpecifier !== m.diagnostic.originalSpecifier
      );
      if (fixable.length > 0) {
        result.set(uriStr, fixable);
      }
    }
    return result;
  }

  getTotalFixableCountInWorkspace(): number {
    let total = 0;
    for (const mismatches of this.mismatchMap.values()) {
      for (const m of mismatches) {
        if (
          !m.diagnostic.isAmbiguous &&
          !!m.diagnostic.correctedSpecifier &&
          m.diagnostic.correctedSpecifier !== m.diagnostic.originalSpecifier
        ) {
          total++;
        }
      }
    }
    return total;
  }

  getWorkspaceFilesWithFixableMismatchesCount(): number {
    return this.getAllFixableMismatchesInWorkspace().size;
  }

  prepareFileBulkFixes(uri: vscode.Uri): {
    valid: boolean;
    edits: { range: vscode.Range; newText: string; originalSpecifier: string }[];
    totalIssues: number;
    error?: string;
  } {
    const fixable = this.getFixableMismatchesForDocument(uri);
    if (fixable.length === 0) {
      return { valid: true, edits: [], totalIssues: 0 };
    }

    let currentText: string | null = null;
    const openDoc = vscode.workspace.textDocuments?.find(
      (d) => d.uri.scheme === 'file' && d.uri.fsPath === uri.fsPath
    );
    if (openDoc) {
      currentText = openDoc.getText();
    } else {
      currentText = this.fs.readFile(uri.fsPath);
    }

    if (currentText === null) {
      return {
        valid: false,
        edits: [],
        totalIssues: fixable.length,
        error: `Could not read content for file: ${path.basename(uri.fsPath)}`,
      };
    }

    const edits: { range: vscode.Range; newText: string; originalSpecifier: string }[] = [];

    for (const m of fixable) {
      if (m.diagnostic.isAmbiguous || !m.diagnostic.correctedSpecifier) {
        return {
          valid: false,
          edits: [],
          totalIssues: fixable.length,
          error: `Ambiguous target found for import '${m.importSpecifier.rawSpecifier}' in ${path.basename(uri.fsPath)}`,
        };
      }

      if (m.diagnostic.correctedSpecifier === m.diagnostic.originalSpecifier) {
        return {
          valid: false,
          edits: [],
          totalIssues: fixable.length,
          error: `No-op edit detected for '${m.importSpecifier.rawSpecifier}' in ${path.basename(uri.fsPath)}`,
        };
      }

      const textAtRange = openDoc
        ? openDoc.getText(m.range)
        : getTextAtRange(currentText, m.range);

      if (textAtRange !== m.importSpecifier.rawSpecifier) {
        return {
          valid: false,
          edits: [],
          totalIssues: fixable.length,
          error: `Stale edit range detected for '${m.importSpecifier.rawSpecifier}' in ${path.basename(uri.fsPath)} (expected '${m.importSpecifier.rawSpecifier}', found '${textAtRange}')`,
        };
      }

      edits.push({
        range: m.range,
        newText: m.diagnostic.correctedSpecifier,
        originalSpecifier: m.importSpecifier.rawSpecifier,
      });
    }

    edits.sort((a, b) => {
      if (a.range.start.line !== b.range.start.line) {
        return a.range.start.line - b.range.start.line;
      }
      return a.range.start.character - b.range.start.character;
    });

    for (let i = 0; i < edits.length - 1; i++) {
      const cur = edits[i];
      const next = edits[i + 1];
      if (
        cur.range.end.line > next.range.start.line ||
        (cur.range.end.line === next.range.start.line && cur.range.end.character > next.range.start.character)
      ) {
        return {
          valid: false,
          edits: [],
          totalIssues: fixable.length,
          error: `Overlapping edit ranges detected in ${path.basename(uri.fsPath)}`,
        };
      }
    }

    return {
      valid: true,
      edits,
      totalIssues: edits.length,
    };
  }

  prepareWorkspaceBulkFixes(): {
    valid: boolean;
    fileEdits: Map<string, { range: vscode.Range; newText: string; originalSpecifier: string }[]>;
    totalIssues: number;
    totalFiles: number;
    error?: string;
  } {
    const allFixable = this.getAllFixableMismatchesInWorkspace();
    const fileEdits = new Map<string, { range: vscode.Range; newText: string; originalSpecifier: string }[]>();
    let totalIssues = 0;

    for (const [uriStr] of allFixable.entries()) {
      const uri = vscode.Uri.parse(uriStr);
      const filePrep = this.prepareFileBulkFixes(uri);
      if (!filePrep.valid) {
        return {
          valid: false,
          fileEdits: new Map(),
          totalIssues: 0,
          totalFiles: 0,
          error: filePrep.error || `Validation failed in ${path.basename(uri.fsPath)}`,
        };
      }
      if (filePrep.edits.length > 0) {
        fileEdits.set(uriStr, filePrep.edits);
        totalIssues += filePrep.edits.length;
      }
    }

    return {
      valid: true,
      fileEdits,
      totalIssues,
      totalFiles: fileEdits.size,
    };
  }

  async applyFileFixes(uri: vscode.Uri, config: ExtensionConfig): Promise<{ success: boolean; count: number; error?: string }> {
    const prep = this.prepareFileBulkFixes(uri);
    if (!prep.valid) {
      return { success: false, count: 0, error: prep.error };
    }
    if (prep.edits.length === 0) {
      return { success: true, count: 0 };
    }

    const edit = new vscode.WorkspaceEdit();
    const sorted = [...prep.edits].sort((a, b) => {
      if (b.range.start.line !== a.range.start.line) {
        return b.range.start.line - a.range.start.line;
      }
      return b.range.start.character - a.range.start.character;
    });

    for (const item of sorted) {
      edit.replace(uri, item.range, item.newText);
    }

    const applied = await vscode.workspace.applyEdit(edit);
    if (applied) {
      const wsRoot = vscode.workspace.getWorkspaceFolder?.(uri)?.uri.fsPath;
      this.scanFile(uri.fsPath, config, wsRoot);
      return { success: true, count: prep.totalIssues };
    }
    return { success: false, count: 0, error: 'WorkspaceEdit application failed' };
  }

  async applyWorkspaceFixes(config: ExtensionConfig): Promise<{ success: boolean; totalIssues: number; totalFiles: number; error?: string }> {
    const prep = this.prepareWorkspaceBulkFixes();
    if (!prep.valid) {
      return { success: false, totalIssues: 0, totalFiles: 0, error: prep.error };
    }
    if (prep.totalIssues === 0) {
      return { success: true, totalIssues: 0, totalFiles: 0 };
    }

    const workspaceEdit = new vscode.WorkspaceEdit();
    for (const [uriStr, edits] of prep.fileEdits.entries()) {
      const uri = vscode.Uri.parse(uriStr);
      const sorted = [...edits].sort((a, b) => {
        if (b.range.start.line !== a.range.start.line) {
          return b.range.start.line - a.range.start.line;
        }
        return b.range.start.character - a.range.start.character;
      });
      for (const item of sorted) {
        workspaceEdit.replace(uri, item.range, item.newText);
      }
    }

    const applied = await vscode.workspace.applyEdit(workspaceEdit);
    if (applied) {
      for (const uriStr of prep.fileEdits.keys()) {
        const uri = vscode.Uri.parse(uriStr);
        const wsRoot = vscode.workspace.getWorkspaceFolder?.(uri)?.uri.fsPath;
        this.scanFile(uri.fsPath, config, wsRoot);
      }
      return { success: true, totalIssues: prep.totalIssues, totalFiles: prep.totalFiles };
    }
    return { success: false, totalIssues: 0, totalFiles: 0, error: 'WorkspaceEdit application failed' };
  }

  dispose(): void {
    this.collection.dispose();
    this.mismatchMap.clear();
    this.documentDependencies.clear();
    this.cache.clear();
  }
}

function isSameOrSubdirectory(candidate: string, targetDir: string): boolean {
  const normCandidate = path.normalize(candidate);
  const normTarget = path.normalize(targetDir);
  if (normCandidate === normTarget) {
    return true;
  }
  const targetWithSep = normTarget.endsWith(path.sep) ? normTarget : normTarget + path.sep;
  return normCandidate.startsWith(targetWithSep);
}
