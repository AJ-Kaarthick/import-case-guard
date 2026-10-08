import { describe, it, beforeEach } from 'node:test';
import * as assert from 'node:assert';
import * as vscode from 'vscode';
import { DiagnosticManager, DIAGNOSTIC_CODE } from '../src/providers/diagnosticManager';
import { MockFileSystem } from '../src/resolver/fileSystem';
import { DEFAULT_CONFIG } from '../src/config';
import { activate } from '../src/extension';

function createMockDocument(fsPath: string, content: string, mockFs?: MockFileSystem) {
  const doc = {
    uri: vscode.Uri.file(fsPath),
    languageId: 'typescript',
    isClosed: false,
    getText: (range?: vscode.Range) => {
      const current = mockFs ? mockFs.readFile(fsPath) || content : content;
      if (!range) return current;
      const lines = current.split('\n');
      const line = lines[range.start.line] || '';
      return line.slice(range.start.character, range.end.character);
    },
    applyEdit: (range: vscode.Range, newText: string) => {
      if (mockFs) {
        mockFs.applyEdit(fsPath, range, newText);
      }
    },
  } as any;
  return doc;
}

describe('Bulk Fix & Automatic Scanning Tests', () => {
  let collection: vscode.DiagnosticCollection;
  let fs: MockFileSystem;
  let dm: DiagnosticManager;

  beforeEach(() => {
    (vscode.workspace as any)._resetAll();
    collection = vscode.languages.createDiagnosticCollection('bulk-test');
    fs = new MockFileSystem();
    (vscode.workspace as any)._mockFs = fs;
    dm = new DiagnosticManager(collection, fs);
  });

  describe('CURRENT-FILE BULK FIX (Tests 9-13)', () => {
    it('9. apply all safe fixes in file', async () => {
      fs.addFile('/project/src/components/Button.tsx', 'export const Button = 1;');
      fs.addFile('/project/src/components/Header.tsx', 'export const Header = 2;');
      const initialContent =
        'import { Button } from "./components/button";\nimport { Header } from "./components/header";';
      fs.addFile('/project/src/index.ts', initialContent);

      dm.scanFile('/project/src/index.ts', DEFAULT_CONFIG, '/project');
      const diagsBefore = collection.get(vscode.Uri.file('/project/src/index.ts'));
      assert.strictEqual(diagsBefore?.length, 2);

      const res = await dm.applyFileFixes(vscode.Uri.file('/project/src/index.ts'), DEFAULT_CONFIG);
      assert.strictEqual(res.success, true);
      assert.strictEqual(res.count, 2);

      const updated = fs.readFile('/project/src/index.ts');
      assert.strictEqual(
        updated,
        'import { Button } from "./components/Button";\nimport { Header } from "./components/Header";'
      );

      const diagsAfter = collection.get(vscode.Uri.file('/project/src/index.ts'));
      assert.strictEqual(diagsAfter?.length, 0, 'Rescan must clear diagnostics after all fixes applied');
    });

    it('10. cancel leaves file unchanged', async () => {
      fs.addFile('/project/src/components/Button.tsx', 'export const Button = 1;');
      fs.addFile('/project/src/components/Header.tsx', 'export const Header = 2;');
      const initialContent =
        'import { Button } from "./components/button";\nimport { Header } from "./components/header";';
      fs.addFile('/project/src/index.ts', initialContent);

      const doc = createMockDocument('/project/src/index.ts', initialContent, fs);
      (vscode.workspace as any).textDocuments = [doc];
      (vscode.window as any).activeTextEditor = { document: doc };
      (vscode.workspace as any).workspaceFolders = [{ uri: vscode.Uri.file('/project') }];

      const context = { subscriptions: [] } as any;
      activate(context, dm);

      dm.scanFile('/project/src/index.ts', DEFAULT_CONFIG, '/project');

      // User chooses Cancel
      (vscode.window as any).confirmationResponse = 'Cancel';

      await vscode.commands.executeCommand('import-case-guard.fixAllInFile', doc.uri);

      const contentAfter = fs.readFile('/project/src/index.ts');
      assert.strictEqual(contentAfter, initialContent, 'File must remain unchanged upon cancel');
    });

    it('11. validation failure leaves file unchanged', async () => {
      fs.addFile('/project/src/components/Button.tsx', 'export const Button = 1;');
      fs.addFile('/project/src/components/Header.tsx', 'export const Header = 2;');
      const initialContent =
        'import { Button } from "./components/button";\nimport { Header } from "./components/header";';
      fs.addFile('/project/src/index.ts', initialContent);

      // Initial scan records coordinates
      dm.scanFile('/project/src/index.ts', DEFAULT_CONFIG, '/project');

      // Out-of-band edit shifts the lines so range becomes stale
      const corruptedContent = '// inserted line\n' + initialContent;
      fs.addFile('/project/src/index.ts', corruptedContent);

      // Attempt bulk fix
      const res = await dm.applyFileFixes(vscode.Uri.file('/project/src/index.ts'), DEFAULT_CONFIG);
      assert.strictEqual(res.success, false, 'Must fail validation on stale edit range');
      assert.ok(res.error?.includes('Stale edit range'));

      // File content must not have any botched edits applied
      const postContent = fs.readFile('/project/src/index.ts');
      assert.strictEqual(postContent, corruptedContent, 'File must remain untouched when validation fails');
    });

    it('12. multiple edits preserve formatting', async () => {
      fs.addFile('/project/src/components/Button.tsx', 'export const Button = 1;');
      fs.addFile('/project/src/components/Header.tsx', 'export const Header = 2;');
      const customFormatted =
        'import    Button    from   "./components/button"  ;  // comment 1\n\n' +
        'import   Header   from   "./components/header"  ;  // comment 2';
      fs.addFile('/project/src/index.ts', customFormatted);

      dm.scanFile('/project/src/index.ts', DEFAULT_CONFIG, '/project');

      const res = await dm.applyFileFixes(vscode.Uri.file('/project/src/index.ts'), DEFAULT_CONFIG);
      assert.strictEqual(res.success, true);
      assert.strictEqual(res.count, 2);

      const fixed = fs.readFile('/project/src/index.ts');
      assert.strictEqual(
        fixed,
        'import    Button    from   "./components/Button"  ;  // comment 1\n\n' +
        'import   Header   from   "./components/Header"  ;  // comment 2',
        'Surrounding whitespace, indentation, and comments must be perfectly preserved'
      );
    });

    it('13. undo works', async () => {
      fs.addFile('/project/src/components/Button.tsx', 'export const Button = 1;');
      fs.addFile('/project/src/components/Header.tsx', 'export const Header = 2;');
      const initialContent =
        'import { Button } from "./components/button";\nimport { Header } from "./components/header";';
      fs.addFile('/project/src/index.ts', initialContent);

      dm.scanFile('/project/src/index.ts', DEFAULT_CONFIG, '/project');
      await dm.applyFileFixes(vscode.Uri.file('/project/src/index.ts'), DEFAULT_CONFIG);

      const modified = fs.readFile('/project/src/index.ts');
      assert.notStrictEqual(modified, initialContent);

      // Trigger undo in MockFileSystem
      const undoOk = fs.undo();
      assert.strictEqual(undoOk, true);
      while (fs.undo()) {}
      assert.strictEqual(fs.readFile('/project/src/index.ts'), initialContent, 'Undo must restore original content');
    });
  });

  describe('WORKSPACE BULK FIX (Tests 14-22)', () => {
    it('14. apply fixes across multiple files', async () => {
      fs.addFile('/project/src/Button.tsx', 'export const Button = 1;');
      fs.addFile('/project/src/Header.tsx', 'export const Header = 2;');
      fs.addFile('/project/src/fileA.ts', 'import { Button } from "./button";');
      fs.addFile('/project/src/fileB.ts', 'import { Header } from "./header";');

      dm.scanWorkspace(['/project'], DEFAULT_CONFIG);
      assert.strictEqual(dm.getTotalFixableCountInWorkspace(), 2);
      assert.strictEqual(dm.getWorkspaceFilesWithFixableMismatchesCount(), 2);

      const res = await dm.applyWorkspaceFixes(DEFAULT_CONFIG);
      assert.strictEqual(res.success, true);
      assert.strictEqual(res.totalIssues, 2);
      assert.strictEqual(res.totalFiles, 2);

      assert.strictEqual(fs.readFile('/project/src/fileA.ts'), 'import { Button } from "./Button";');
      assert.strictEqual(fs.readFile('/project/src/fileB.ts'), 'import { Header } from "./Header";');

      // Rescanned: 0 diagnostics remain
      assert.strictEqual(collection.get(vscode.Uri.file('/project/src/fileA.ts'))?.length, 0);
      assert.strictEqual(collection.get(vscode.Uri.file('/project/src/fileB.ts'))?.length, 0);
    });

    it('15. cancel leaves every file unchanged', async () => {
      fs.addFile('/project/src/Button.tsx', 'export const Button = 1;');
      fs.addFile('/project/src/Header.tsx', 'export const Header = 2;');
      const contentA = 'import { Button } from "./button";';
      const contentB = 'import { Header } from "./header";';
      fs.addFile('/project/src/fileA.ts', contentA);
      fs.addFile('/project/src/fileB.ts', contentB);

      (vscode.workspace as any).workspaceFolders = [{ uri: vscode.Uri.file('/project') }];
      const context = { subscriptions: [] } as any;
      activate(context, dm);

      dm.scanWorkspace(['/project'], DEFAULT_CONFIG);

      // User cancels workspace bulk fix
      (vscode.window as any).confirmationResponse = 'Cancel';
      await vscode.commands.executeCommand('import-case-guard.fixAllInWorkspace');

      assert.strictEqual(fs.readFile('/project/src/fileA.ts'), contentA);
      assert.strictEqual(fs.readFile('/project/src/fileB.ts'), contentB);
    });

    it('16. validation failure leaves every file unchanged (atomic abort)', async () => {
      fs.addFile('/project/src/Button.tsx', 'export const Button = 1;');
      fs.addFile('/project/src/Header.tsx', 'export const Header = 2;');
      const contentA = 'import { Button } from "./button";';
      const contentB = 'import { Header } from "./header";';
      fs.addFile('/project/src/fileA.ts', contentA);
      fs.addFile('/project/src/fileB.ts', contentB);

      dm.scanWorkspace(['/project'], DEFAULT_CONFIG);

      // Corrupt fileB so range becomes stale
      const shiftedB = '// comment\n' + contentB;
      fs.addFile('/project/src/fileB.ts', shiftedB);

      // Workspace bulk fix should atomically abort before applying edits to ANY file
      const res = await dm.applyWorkspaceFixes(DEFAULT_CONFIG);
      assert.strictEqual(res.success, false);
      assert.strictEqual(res.totalIssues, 0);

      // fileA must NOT have been modified
      assert.strictEqual(fs.readFile('/project/src/fileA.ts'), contentA, 'fileA must remain untouched');
      assert.strictEqual(fs.readFile('/project/src/fileB.ts'), shiftedB, 'fileB must remain untouched');
    });

    it('17. respects exclusions', async () => {
      fs.addFile('/project/src/Button.tsx', 'export const Button = 1;');
      fs.addFile('/project/src/fileA.ts', 'import { Button } from "./button";');
      const excludedContent = 'import { Button } from "./button";';
      fs.addFile('/project/node_modules/pkg/index.ts', excludedContent);
      fs.addFile('/project/dist/index.js', excludedContent);

      dm.scanWorkspace(['/project'], DEFAULT_CONFIG);

      const prep = dm.prepareWorkspaceBulkFixes();
      assert.strictEqual(prep.totalIssues, 1, 'Only non-excluded fileA.ts should be prepared');
      assert.strictEqual(prep.totalFiles, 1);

      await dm.applyWorkspaceFixes(DEFAULT_CONFIG);

      assert.strictEqual(fs.readFile('/project/node_modules/pkg/index.ts'), excludedContent);
      assert.strictEqual(fs.readFile('/project/dist/index.js'), excludedContent);
    });

    it('18. supports multiple workspace roots', async () => {
      fs.addFile('/root1/src/Button.tsx', 'export const Button = 1;');
      fs.addFile('/root1/src/index.ts', 'import { Button } from "./button";');
      fs.addFile('/root2/src/Header.tsx', 'export const Header = 2;');
      fs.addFile('/root2/src/index.ts', 'import { Header } from "./header";');

      dm.scanWorkspace(['/root1', '/root2'], DEFAULT_CONFIG);
      assert.strictEqual(dm.getTotalFixableCountInWorkspace(), 2);
      assert.strictEqual(dm.getWorkspaceFilesWithFixableMismatchesCount(), 2);

      const res = await dm.applyWorkspaceFixes(DEFAULT_CONFIG);
      assert.strictEqual(res.success, true);
      assert.strictEqual(res.totalIssues, 2);
      assert.strictEqual(res.totalFiles, 2);

      assert.strictEqual(fs.readFile('/root1/src/index.ts'), 'import { Button } from "./Button";');
      assert.strictEqual(fs.readFile('/root2/src/index.ts'), 'import { Header } from "./Header";');
    });

    it('19. handles zero findings cleanly', async () => {
      fs.addFile('/project/src/Button.tsx', 'export const Button = 1;');
      fs.addFile('/project/src/index.ts', 'import { Button } from "./Button";');

      (vscode.workspace as any).workspaceFolders = [{ uri: vscode.Uri.file('/project') }];
      const context = { subscriptions: [] } as any;
      activate(context, dm);

      dm.scanWorkspace(['/project'], DEFAULT_CONFIG);

      await vscode.commands.executeCommand('import-case-guard.fixAllInWorkspace');

      assert.strictEqual(
        (vscode.window as any).lastInformationMessage,
        'Import Case Guard: No fixable import casing issues found in workspace.'
      );
    });

    it('20. does not modify unrelated files', async () => {
      fs.addFile('/project/src/Button.tsx', 'export const Button = 1;');
      fs.addFile('/project/src/index.ts', 'import { Button } from "./button";');
      const unrelatedContent = 'export const PI = 3.14159;\nexport function add(a, b) { return a + b; }';
      fs.addFile('/project/src/utils/math.ts', unrelatedContent);

      dm.scanWorkspace(['/project'], DEFAULT_CONFIG);
      await dm.applyWorkspaceFixes(DEFAULT_CONFIG);

      assert.strictEqual(fs.readFile('/project/src/utils/math.ts'), unrelatedContent);
    });

    it('21. no unsafe/ambiguous fixes applied', async () => {
      fs.addFile('/project/src/Button.tsx', 'export const Button = 1;');
      fs.addFile('/project/src/button.tsx', 'export const Button = 2;');
      const ambiguousContent = 'import { Button } from "./BUTTON";';
      fs.addFile('/project/src/index.ts', ambiguousContent);

      dm.scanWorkspace(['/project'], DEFAULT_CONFIG);

      const prep = dm.prepareWorkspaceBulkFixes();
      assert.strictEqual(prep.totalIssues, 0, 'Ambiguous import must NOT be included in bulk fixes');
      assert.strictEqual(prep.totalFiles, 0);

      await dm.applyWorkspaceFixes(DEFAULT_CONFIG);
      assert.strictEqual(fs.readFile('/project/src/index.ts'), ambiguousContent);
    });

    it('22. duplicate diagnostics avoided', async () => {
      fs.addFile('/project/src/Button.tsx', 'export const Button = 1;');
      fs.addFile('/project/src/Header.tsx', 'export const Header = 2;');
      fs.addFile('/project/src/index.ts', 'import { Button } from "./button";\nimport { Header } from "./header";');

      dm.scanWorkspace(['/project'], DEFAULT_CONFIG);
      assert.strictEqual(collection.get(vscode.Uri.file('/project/src/index.ts'))?.length, 2);

      await dm.applyWorkspaceFixes(DEFAULT_CONFIG);
      const postDiags = collection.get(vscode.Uri.file('/project/src/index.ts'));
      assert.strictEqual(postDiags?.length, 0, 'No remaining or duplicate diagnostics');
    });
  });

  describe('AUTOMATIC SCANNING LIFECYCLE (Tests 23-29)', () => {
    it('23. activation begins workspace scanning', async () => {
      fs.addFile('/project/src/Button.tsx', 'export const Button = 1;');
      fs.addFile('/project/src/index.ts', 'import { Button } from "./button";');

      (vscode.workspace as any).workspaceFolders = [{ uri: vscode.Uri.file('/project') }];
      const context = { subscriptions: [] } as any;

      activate(context, dm);

      // Wait 70ms for background timeout (50ms configured in extension.ts)
      await new Promise((resolve) => setTimeout(resolve, 80));

      const diags = collection.get(vscode.Uri.file('/project/src/index.ts'));
      assert.ok(diags && diags.length === 1, 'Automatic background scan must populate diagnostics on activation');
    });

    it('24. open file automatically scans', () => {
      fs.addFile('/project/src/Button.tsx', 'export const Button = 1;');
      const content = 'import { Button } from "./button";';
      fs.addFile('/project/src/index.ts', content);

      const context = { subscriptions: [] } as any;
      activate(context, dm);

      const doc = createMockDocument('/project/src/index.ts', content, fs);
      (vscode.workspace as any).textDocuments = [doc];

      // Fire open text document
      (vscode.workspace as any)._fireOpenTextDocument(doc);

      const diags = collection.get(vscode.Uri.file('/project/src/index.ts'));
      assert.ok(diags && diags.length === 1, 'Opening document must automatically trigger scan');
    });

    it('25. edit automatically rescans', async () => {
      fs.addFile('/project/src/Button.tsx', 'export const Button = 1;');
      const initialContent = 'import { Button } from "./Button";'; // initially valid
      fs.addFile('/project/src/index.ts', initialContent);

      const context = { subscriptions: [] } as any;
      activate(context, dm);

      const doc = createMockDocument('/project/src/index.ts', initialContent, fs);
      (vscode.workspace as any).textDocuments = [doc];
      (vscode.workspace as any)._fireOpenTextDocument(doc);

      assert.strictEqual(collection.get(vscode.Uri.file('/project/src/index.ts'))?.length, 0);

      // User edits file introducing a casing mismatch
      const editedContent = 'import { Button } from "./button";';
      fs.addFile('/project/src/index.ts', editedContent);

      (vscode.workspace as any)._fireChangeTextDocument({ document: doc });

      // Wait for debounce (300ms default)
      await new Promise((resolve) => setTimeout(resolve, 350));

      const diags = collection.get(vscode.Uri.file('/project/src/index.ts'));
      assert.ok(diags && diags.length === 1, 'Debounced rescan must populate diagnostic after edit');
    });

    it('26. save automatically rescans', () => {
      fs.addFile('/project/src/Button.tsx', 'export const Button = 1;');
      const savedContent = 'import { Button } from "./button";';
      fs.addFile('/project/src/index.ts', savedContent);

      const context = { subscriptions: [] } as any;
      activate(context, dm);

      const doc = createMockDocument('/project/src/index.ts', savedContent, fs);
      (vscode.workspace as any).textDocuments = [doc];

      (vscode.workspace as any)._fireSaveTextDocument(doc);

      const diags = collection.get(vscode.Uri.file('/project/src/index.ts'));
      assert.ok(diags && diags.length === 1, 'Saving document must immediately trigger scan');
    });

    it('27. active editor switch scans', () => {
      fs.addFile('/project/src/Button.tsx', 'export const Button = 1;');
      const content = 'import { Button } from "./button";';
      fs.addFile('/project/src/index.ts', content);

      const context = { subscriptions: [] } as any;
      activate(context, dm);

      const doc = createMockDocument('/project/src/index.ts', content, fs);
      (vscode.workspace as any).textDocuments = [doc];

      (vscode.window as any)._fireChangeActiveTextEditor({ document: doc });

      const diags = collection.get(vscode.Uri.file('/project/src/index.ts'));
      assert.ok(diags && diags.length === 1, 'Switching active editor must trigger scan');
    });

    it('28. filesystem changes trigger targeted rescans', async () => {
      fs.addFile('/project/src/components/Button.tsx', 'export const Button = 1;');
      const docContent = 'import { Button } from "./components/button";';
      fs.addFile('/project/src/index.ts', docContent);

      const context = { subscriptions: [] } as any;
      activate(context, dm);

      const doc = createMockDocument('/project/src/index.ts', docContent, fs);
      (vscode.workspace as any).textDocuments = [doc];
      (vscode.workspace as any)._fireOpenTextDocument(doc);

      // Verify dependency tracked
      assert.ok(dm.isDocumentAffectedByDir(doc.uri, '/project/src/components'));

      // Simulate file watcher firing for changed file in components
      const watcher = (vscode.workspace as any)._watchers[0];
      assert.ok(watcher, 'Watcher must be registered');

      watcher.fireChange(vscode.Uri.file('/project/src/components/Button.tsx'));

      // Wait for watcher debounce (150ms)
      await new Promise((resolve) => setTimeout(resolve, 200));

      const diags = collection.get(vscode.Uri.file('/project/src/index.ts'));
      assert.ok(diags && diags.length === 1, 'Watcher event must trigger rescan of affected document');
    });

    it('29. automatic scanning never modifies source', async () => {
      fs.addFile('/project/src/Button.tsx', 'export const Button = 1;');
      const originalIndex = 'import { Button } from "./button";';
      fs.addFile('/project/src/index.ts', originalIndex);

      (vscode.workspace as any).workspaceFolders = [{ uri: vscode.Uri.file('/project') }];
      const context = { subscriptions: [] } as any;
      activate(context, dm);

      const doc = createMockDocument('/project/src/index.ts', originalIndex, fs);
      (vscode.workspace as any).textDocuments = [doc];

      // Run ALL automatic triggers
      (vscode.workspace as any)._fireOpenTextDocument(doc);
      (vscode.workspace as any)._fireChangeTextDocument({ document: doc });
      (vscode.workspace as any)._fireSaveTextDocument(doc);
      (vscode.window as any)._fireChangeActiveTextEditor({ document: doc });
      const watcher = (vscode.workspace as any)._watchers[0];
      if (watcher) {
        watcher.fireChange(vscode.Uri.file('/project/src/Button.tsx'));
      }

      await new Promise((resolve) => setTimeout(resolve, 350));

      // Assert that source files remain 100% byte-for-byte untouched
      assert.strictEqual(
        fs.readFile('/project/src/index.ts'),
        originalIndex,
        'index.ts must NOT be modified by any automatic scanning event'
      );
      assert.strictEqual(
        fs.readFile('/project/src/Button.tsx'),
        'export const Button = 1;',
        'Button.tsx must NOT be modified by any automatic scanning event'
      );
    });
  });
});
