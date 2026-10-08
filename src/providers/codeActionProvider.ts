import * as vscode from 'vscode';
import { DiagnosticManager, DIAGNOSTIC_CODE } from './diagnosticManager';

export class ImportCaseCodeActionProvider implements vscode.CodeActionProvider {
  public static readonly providedCodeActionKinds = [vscode.CodeActionKind.QuickFix];

  private diagnosticManager: DiagnosticManager;

  constructor(diagnosticManager: DiagnosticManager) {
    this.diagnosticManager = diagnosticManager;
  }

  provideCodeActions(
    document: vscode.TextDocument,
    range: vscode.Range | vscode.Selection,
    context: vscode.CodeActionContext,
    _token: vscode.CancellationToken
  ): vscode.CodeAction[] {
    const actions: vscode.CodeAction[] = [];

    // Filter for our extension's diagnostics in the current context
    const caseDiagnostics = context.diagnostics.filter((d) => d.code === DIAGNOSTIC_CODE);

    for (const diag of caseDiagnostics) {
      const mismatch = this.diagnosticManager.findMismatchForDiagnostic(document.uri, diag);
      if (!mismatch) continue;

      const { diagnostic } = mismatch;

      // When a safe exact correction cannot be determined or is ambiguous, do not offer Quick Fix
      if (
        diagnostic.isAmbiguous ||
        !diagnostic.correctedSpecifier ||
        diagnostic.correctedSpecifier === diagnostic.originalSpecifier
      ) {
        continue;
      }

      // Safety check: verify that the document text at the recorded range still matches
      // the original import specifier. If user edits have shifted or altered the text,
      // reject the stale range to never overwrite unrelated code.
      const currentText = document.getText(mismatch.range);
      if (currentText !== mismatch.importSpecifier.rawSpecifier) {
        continue;
      }

      const title = `Correct import casing to '${diagnostic.correctedSpecifier}'`;
      const action = new vscode.CodeAction(title, vscode.CodeActionKind.QuickFix);
      action.diagnostics = [diag];
      action.isPreferred = true;

      const edit = new vscode.WorkspaceEdit();
      // Replace only the inner string specifier, preserving quotes and surrounding syntax
      edit.replace(document.uri, mismatch.range, diagnostic.correctedSpecifier);
      action.edit = edit;

      actions.push(action);
    }

    // Also support cursor being on the import even if context.diagnostics is empty
    if (actions.length === 0) {
      const mismatch = this.diagnosticManager.findMismatchAtPosition(document.uri, range.start);
      if (
        mismatch &&
        !mismatch.diagnostic.isAmbiguous &&
        mismatch.diagnostic.correctedSpecifier &&
        mismatch.diagnostic.correctedSpecifier !== mismatch.diagnostic.originalSpecifier
      ) {
        const currentText = document.getText(mismatch.range);
        if (currentText === mismatch.importSpecifier.rawSpecifier) {
          const title = `Correct import casing to '${mismatch.diagnostic.correctedSpecifier}'`;
          const action = new vscode.CodeAction(title, vscode.CodeActionKind.QuickFix);
          action.isPreferred = true;

          const edit = new vscode.WorkspaceEdit();
          edit.replace(document.uri, mismatch.range, mismatch.diagnostic.correctedSpecifier);
          action.edit = edit;

          actions.push(action);
        }
      }
    }

    // Add scoped bulk remediation actions when contextual diagnostic is present
    if (actions.length > 0) {
      const fileFixables = this.diagnosticManager.getFixableMismatchesForDocument(document.uri);
      const totalWorkspaceFixables = this.diagnosticManager.getTotalFixableCountInWorkspace();

      // B. Fix all in current file (when multiple fixable issues exist in this file)
      if (fileFixables.length > 1) {
        const fileAction = new vscode.CodeAction(
          `Fix all ${fileFixables.length} import casing issues in this file`,
          vscode.CodeActionKind.QuickFix
        );
        fileAction.command = {
          command: 'import-case-guard.fixAllInFile',
          title: 'Fix All in Current File',
          arguments: [document.uri],
        };
        actions.push(fileAction);
      }

      // C. Fix all in workspace (when workspace has findings across other files or multiple files)
      const isWorkspaceActionUseful =
        totalWorkspaceFixables > 1 &&
        (totalWorkspaceFixables > fileFixables.length ||
          this.diagnosticManager.getWorkspaceFilesWithFixableMismatchesCount() > 1);

      if (isWorkspaceActionUseful) {
        const wsAction = new vscode.CodeAction(
          `Fix all ${totalWorkspaceFixables} import casing issues in workspace`,
          vscode.CodeActionKind.QuickFix
        );
        wsAction.command = {
          command: 'import-case-guard.fixAllInWorkspace',
          title: 'Fix All in Workspace',
        };
        actions.push(wsAction);
      }
    }

    return actions;
  }
}
