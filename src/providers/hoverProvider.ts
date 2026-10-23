import * as vscode from 'vscode';
import { DiagnosticManager } from './diagnosticManager';

export class ImportCaseHoverProvider implements vscode.HoverProvider {
  private diagnosticManager: DiagnosticManager;

  constructor(diagnosticManager: DiagnosticManager) {
    this.diagnosticManager = diagnosticManager;
  }

  provideHover(
    document: vscode.TextDocument,
    position: vscode.Position,
    _token: vscode.CancellationToken
  ): vscode.ProviderResult<vscode.Hover> {
    const mismatch = this.diagnosticManager.findMismatchAtPosition(document.uri, position);
    if (!mismatch) {
      return null;
    }

    const { diagnostic, range } = mismatch;
    const md = new vscode.MarkdownString();
    md.isTrusted = false;

    md.appendMarkdown('### Import Case Guard\n\n');

    if (diagnostic.isAmbiguous) {
      md.appendMarkdown(`- **Requested import**: \`${diagnostic.originalSpecifier}\`\n`);
      md.appendMarkdown(
        '- **Ambiguity**: Multiple filesystem entries match with different casing. Quick Fix is unavailable to prevent accidental edits.\n'
      );
    } else {
      md.appendMarkdown(`- **Requested import**: \`${diagnostic.originalSpecifier}\`\n`);
      if (diagnostic.matchedPattern) {
        md.appendMarkdown(`- **Alias pattern**: \`${diagnostic.matchedPattern}\`\n`);
      }
      if (diagnostic.correctedSpecifier) {
        md.appendMarkdown(`- **Corrected import**: \`${diagnostic.correctedSpecifier}\`\n`);
      }
      if (diagnostic.actualDiskPath) {
        md.appendMarkdown(`- **Actual file path**: \`${diagnostic.actualDiskPath}\`\n`);
      }
      md.appendMarkdown(
        '\n*Why this matters*: Case-insensitive filesystems (macOS, Windows) resolve this path, but it will fail on case-sensitive environments such as Linux CI/CD build systems.\n'
      );
    }

    return new vscode.Hover(md, range);
  }
}
