import * as vscode from 'vscode';
import * as path from 'path';
import { DiagnosticManager } from './providers/diagnosticManager';
import { ImportCaseHoverProvider } from './providers/hoverProvider';
import { ImportCaseCodeActionProvider } from './providers/codeActionProvider';
import { DEFAULT_CONFIG, ExtensionConfig, isPathExcluded } from './config';

const SUPPORTED_LANGUAGES = ['javascript', 'javascriptreact', 'typescript', 'typescriptreact'];

export function activate(context: vscode.ExtensionContext, customDm?: DiagnosticManager) {
  const collection = vscode.languages.createDiagnosticCollection('import-case-guard');
  const diagnosticManager = customDm || new DiagnosticManager(collection);

  // Debounce timers per document URI
  const debounceTimers = new Map<string, NodeJS.Timeout>();

  function getConfig(): ExtensionConfig {
    const wsConfig = vscode.workspace.getConfiguration('importCaseGuard');
    return {
      enable: wsConfig.get<boolean>('enable', DEFAULT_CONFIG.enable),
      debounceMs: wsConfig.get<number>('debounceMs', DEFAULT_CONFIG.debounceMs),
      exclude: wsConfig.get<string[]>('exclude', DEFAULT_CONFIG.exclude),
    };
  }

  function triggerScan(document: vscode.TextDocument) {
    if (!document || document.uri.scheme !== 'file') {
      return;
    }
    const config = getConfig();
    diagnosticManager.scanDocument(document, config);
  }

  function triggerDebouncedScan(document: vscode.TextDocument) {
    if (!document || document.uri.scheme !== 'file') {
      return;
    }
    const uriStr = document.uri.toString();
    const existing = debounceTimers.get(uriStr);
    if (existing) {
      clearTimeout(existing);
    }

    const config = getConfig();
    const timer = setTimeout(() => {
      debounceTimers.delete(uriStr);
      diagnosticManager.scanDocument(document, config);
    }, config.debounceMs);

    debounceTimers.set(uriStr, timer);
  }

  // 1. Scan currently open visible editors on activation
  for (const editor of vscode.window.visibleTextEditors) {
    if (SUPPORTED_LANGUAGES.includes(editor.document.languageId)) {
      triggerScan(editor.document);
    }
  }

  // 1.5 Initial automatic background workspace scan on activation
  const initialWorkspaceFolders = vscode.workspace.workspaceFolders;
  if (initialWorkspaceFolders && initialWorkspaceFolders.length > 0) {
    const config = getConfig();
    if (config.enable) {
      setTimeout(() => {
        const roots = initialWorkspaceFolders.map((f) => f.uri.fsPath);
        diagnosticManager.scanWorkspace(roots, config);
      }, 50);
    }
  }

  // 2. Document event listeners
  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument((document) => {
      if (SUPPORTED_LANGUAGES.includes(document.languageId)) {
        triggerScan(document);
      }
    }),

    vscode.workspace.onDidChangeTextDocument((event) => {
      if (SUPPORTED_LANGUAGES.includes(event.document.languageId)) {
        triggerDebouncedScan(event.document);
      }
    }),

    vscode.workspace.onDidSaveTextDocument((document) => {
      if (SUPPORTED_LANGUAGES.includes(document.languageId)) {
        triggerScan(document);
      }
    }),

    vscode.workspace.onDidCloseTextDocument((document) => {
      const uriStr = document.uri.toString();
      const timer = debounceTimers.get(uriStr);
      if (timer) {
        clearTimeout(timer);
        debounceTimers.delete(uriStr);
      }
      diagnosticManager.clearDocument(document.uri);
    }),

    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (editor && SUPPORTED_LANGUAGES.includes(editor.document.languageId)) {
        triggerScan(editor.document);
      }
    })
  );

  // 3. Targeted file watcher invalidation
  // Invalidates affected directory cache and triggers debounced rescans only for open documents affected
  let watcherDebounceTimer: NodeJS.Timeout | undefined;
  const pendingChangedDirs = new Set<string>();

  const watcher = vscode.workspace.createFileSystemWatcher('**/*.{js,jsx,ts,tsx,mjs,cjs,json}');
  function handleFsChange(uri: vscode.Uri) {
    if (!uri || uri.scheme !== 'file') return;

    const config = getConfig();
    const wsFolder = vscode.workspace.getWorkspaceFolder?.(uri)?.uri.fsPath;
    if (isPathExcluded(uri.fsPath, config.exclude, wsFolder)) {
      return;
    }

    const parentDir = diagnosticManager.getCache().invalidateFile(uri.fsPath);
    pendingChangedDirs.add(parentDir);

    if (watcherDebounceTimer) {
      clearTimeout(watcherDebounceTimer);
    }

    watcherDebounceTimer = setTimeout(() => {
      const dirsToProcess = Array.from(pendingChangedDirs);
      pendingChangedDirs.clear();

      for (const doc of vscode.workspace.textDocuments) {
        if (!doc.isClosed && SUPPORTED_LANGUAGES.includes(doc.languageId)) {
          const isAffected = dirsToProcess.some((d) =>
            diagnosticManager.isDocumentAffectedByDir(doc.uri, d)
          );
          if (isAffected) {
            triggerScan(doc);
          }
        }
      }
    }, 150);
  }

  context.subscriptions.push(
    watcher,
    watcher.onDidCreate(handleFsChange),
    watcher.onDidChange(handleFsChange),
    watcher.onDidDelete(handleFsChange)
  );

  // 4. Configuration change listener
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('importCaseGuard')) {
        const config = getConfig();
        if (!config.enable) {
          diagnosticManager.clearAll();
        } else {
          // Rescan only open documents
          for (const doc of vscode.workspace.textDocuments) {
            if (!doc.isClosed && SUPPORTED_LANGUAGES.includes(doc.languageId)) {
              diagnosticManager.scanDocument(doc, config);
            }
          }
        }
      }
    })
  );

  // 5. Providers
  const documentSelector: vscode.DocumentSelector = SUPPORTED_LANGUAGES.map((lang) => ({
    language: lang,
    scheme: 'file',
  }));

  context.subscriptions.push(
    vscode.languages.registerHoverProvider(
      documentSelector,
      new ImportCaseHoverProvider(diagnosticManager)
    ),
    vscode.languages.registerCodeActionsProvider(
      documentSelector,
      new ImportCaseCodeActionProvider(diagnosticManager),
      {
        providedCodeActionKinds: ImportCaseCodeActionProvider.providedCodeActionKinds,
      }
    )
  );

  // 6. Command Palette command: Scan Current File
  context.subscriptions.push(
    vscode.commands.registerCommand('import-case-guard.scanCurrentFile', () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showInformationMessage('Import Case Guard: No active file to scan.');
        return;
      }

      const document = editor.document;
      if (!SUPPORTED_LANGUAGES.includes(document.languageId)) {
        vscode.window.showInformationMessage(
          `Import Case Guard: '${document.languageId}' files are not supported.`
        );
        return;
      }

      const config = getConfig();
      const wsFolder = vscode.workspace.getWorkspaceFolder?.(document.uri)?.uri.fsPath;
      if (isPathExcluded(document.uri.fsPath, config.exclude, wsFolder)) {
        vscode.window.showInformationMessage(
          'Import Case Guard: Current file is excluded by configuration.'
        );
        return;
      }

      const mismatches = diagnosticManager.scanDocument(document, config);
      if (mismatches.length === 0) {
        vscode.window.showInformationMessage('Import Case Guard: No import path casing issues found.');
      } else {
        vscode.window.showWarningMessage(
          `Import Case Guard: Found ${mismatches.length} import path casing ${
            mismatches.length === 1 ? 'mismatch' : 'mismatches'
          }.`
        );
      }
    }),

    // 7. Command Palette command: Scan Workspace
    vscode.commands.registerCommand('import-case-guard.scanWorkspace', () => {
      const folders = vscode.workspace.workspaceFolders;
      if (!folders || folders.length === 0) {
        vscode.window.showInformationMessage('Import Case Guard: No workspace folder is open.');
        return;
      }

      const config = getConfig();
      if (!config.enable) {
        vscode.window.showInformationMessage(
          'Import Case Guard: Linting is currently disabled in settings.'
        );
        return;
      }

      const workspaceRoots = folders.map((f) => f.uri.fsPath);
      const { scannedFileCount, mismatchCount } = diagnosticManager.scanWorkspace(
        workspaceRoots,
        config
      );

      const msg = `Import Case Guard: Scanned ${scannedFileCount} ${
        scannedFileCount === 1 ? 'file' : 'files'
      } — ${mismatchCount} import casing ${
        mismatchCount === 1 ? 'issue' : 'issues'
      } found.`;

      if (mismatchCount === 0) {
        vscode.window.showInformationMessage(msg);
      } else {
        vscode.window.showWarningMessage(msg);
      }
    }),

    // 8. Command: Fix All in Current File
    vscode.commands.registerCommand('import-case-guard.fixAllInFile', async (targetUri?: vscode.Uri) => {
      const editor = vscode.window.activeTextEditor;
      const uri = targetUri || editor?.document.uri;
      if (!uri) {
        vscode.window.showInformationMessage('Import Case Guard: No file active to fix.');
        return;
      }

      const config = getConfig();
      const prep = diagnosticManager.prepareFileBulkFixes(uri);
      if (!prep.valid) {
        vscode.window.showErrorMessage(
          `Import Case Guard: Fix all cancelled — ${prep.error || 'validation failed'}. No changes were made.`
        );
        return;
      }

      if (prep.totalIssues === 0) {
        vscode.window.showInformationMessage(
          'Import Case Guard: No fixable import casing issues found in this file.'
        );
        return;
      }

      const fileName = path.basename(uri.fsPath);
      const confirm = await vscode.window.showInformationMessage(
        `Import Case Guard: Fix all ${prep.totalIssues} import casing ${
          prep.totalIssues === 1 ? 'issue' : 'issues'
        } in ${fileName}?`,
        'Apply Fixes',
        'Cancel'
      );

      if (confirm !== 'Apply Fixes') {
        return;
      }

      const result = await diagnosticManager.applyFileFixes(uri, config);
      if (result.success) {
        vscode.window.showInformationMessage(
          `Import Case Guard: Fixed ${result.count} import casing ${
            result.count === 1 ? 'issue' : 'issues'
          } in ${fileName}.`
        );
      } else {
        vscode.window.showErrorMessage(
          `Import Case Guard: Fix all failed — ${result.error || 'unknown error'}. No changes were made.`
        );
      }
    }),

    // 9. Command: Fix All in Workspace
    vscode.commands.registerCommand('import-case-guard.fixAllInWorkspace', async () => {
      const config = getConfig();
      const prep = diagnosticManager.prepareWorkspaceBulkFixes();
      if (!prep.valid) {
        vscode.window.showErrorMessage(
          `Import Case Guard: Bulk fix cancelled — ${prep.error || 'validation failed'}. No files were modified.`
        );
        return;
      }

      if (prep.totalIssues === 0) {
        vscode.window.showInformationMessage(
          'Import Case Guard: No fixable import casing issues found in workspace.'
        );
        return;
      }

      const confirm = await vscode.window.showInformationMessage(
        `Import Case Guard: Fix all ${prep.totalIssues} import casing ${
          prep.totalIssues === 1 ? 'issue' : 'issues'
        } across ${prep.totalFiles} ${prep.totalFiles === 1 ? 'file' : 'files'} in workspace?`,
        'Apply Fixes',
        'Cancel'
      );

      if (confirm !== 'Apply Fixes') {
        return;
      }

      const result = await diagnosticManager.applyWorkspaceFixes(config);
      if (result.success) {
        vscode.window.showInformationMessage(
          `Import Case Guard: Fixed ${result.totalIssues} import casing ${
            result.totalIssues === 1 ? 'issue' : 'issues'
          } across ${result.totalFiles} ${result.totalFiles === 1 ? 'file' : 'files'}.`
        );
      } else {
        vscode.window.showErrorMessage(
          `Import Case Guard: Bulk fix failed — ${result.error || 'unknown error'}. No files were modified.`
        );
      }
    })
  );

  // Clean up collection and active debounce/watcher timers on dispose
  context.subscriptions.push(
    diagnosticManager,
    {
      dispose: () => {
        for (const timer of debounceTimers.values()) {
          clearTimeout(timer);
        }
        debounceTimers.clear();
        if (watcherDebounceTimer) {
          clearTimeout(watcherDebounceTimer);
          watcherDebounceTimer = undefined;
        }
      },
    }
  );
}

export function deactivate() {}
