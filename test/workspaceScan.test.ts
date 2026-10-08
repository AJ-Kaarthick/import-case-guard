import { describe, it, beforeEach } from 'node:test';
import * as assert from 'node:assert';
import * as vscode from 'vscode';
import { DiagnosticManager } from '../src/providers/diagnosticManager';
import { MockFileSystem } from '../src/resolver/fileSystem';
import { DEFAULT_CONFIG } from '../src/config';

describe('Workspace Scan Tests', () => {
  let collection: vscode.DiagnosticCollection;
  let fs: MockFileSystem;
  let dm: DiagnosticManager;

  beforeEach(() => {
    collection = vscode.languages.createDiagnosticCollection('import-case-guard-test');
    fs = new MockFileSystem();
    dm = new DiagnosticManager(collection, fs);
  });

  it('1. workspace scan finds issues across multiple files', () => {
    fs.addFile('/project/src/ComponentA.tsx', 'export const A = 1;');
    fs.addFile('/project/src/ComponentB.tsx', 'export const B = 2;');
    fs.addFile(
      '/project/src/index.ts',
      'import { A } from "./componenta";\nexport { A };'
    );
    fs.addFile(
      '/project/src/utils/helpers.ts',
      'import { B } from "../componentb";\nexport { B };'
    );

    const result = dm.scanWorkspace(['/project'], DEFAULT_CONFIG);

    assert.strictEqual(result.scannedFileCount, 4, 'Should scan all 4 supported source files');
    assert.strictEqual(result.mismatchCount, 2, 'Should find exactly 2 casing mismatches across files');

    const indexDiags = collection.get(vscode.Uri.file('/project/src/index.ts'));
    assert.ok(indexDiags && indexDiags.length === 1, 'index.ts must receive 1 diagnostic');
    assert.strictEqual(indexDiags[0].message, 'Import path casing does not match the filesystem.');

    const helperDiags = collection.get(vscode.Uri.file('/project/src/utils/helpers.ts'));
    assert.ok(helperDiags && helperDiags.length === 1, 'helpers.ts must receive 1 diagnostic');
    assert.strictEqual(helperDiags[0].message, 'Import path casing does not match the filesystem.');
  });

  it('2. workspace scan respects exclusions', () => {
    fs.addFile('/project/src/Button.tsx', 'export const Button = () => null;');
    fs.addFile('/project/src/valid.ts', 'import { Button } from "./Button";');
    fs.addFile('/project/dist/bundle.js', 'import { Button } from "./button";');
    fs.addFile('/project/node_modules/lib/index.js', 'import { Button } from "./button";');
    fs.addFile('/project/.next/server.js', 'import { Button } from "./button";');
    fs.addFile('/project/coverage/report.js', 'import { Button } from "./button";');

    const result = dm.scanWorkspace(['/project'], DEFAULT_CONFIG);

    assert.strictEqual(result.scannedFileCount, 2, 'Should only scan files in non-excluded src/ directory');
    assert.strictEqual(result.mismatchCount, 0, 'No mismatches in valid.ts and Button.tsx');

    assert.strictEqual(collection.get(vscode.Uri.file('/project/dist/bundle.js')), undefined);
    assert.strictEqual(collection.get(vscode.Uri.file('/project/node_modules/lib/index.js')), undefined);
    assert.strictEqual(collection.get(vscode.Uri.file('/project/.next/server.js')), undefined);
    assert.strictEqual(collection.get(vscode.Uri.file('/project/coverage/report.js')), undefined);
  });

  it('3. workspace scan handles multiple workspace roots', () => {
    // Root 1
    fs.addFile('/workspace1/packages/pkg-a/src/Button.tsx', 'export const Button = 1;');
    fs.addFile(
      '/workspace1/packages/pkg-a/src/index.ts',
      'import { Button } from "./button";'
    );

    // Root 2
    fs.addFile('/workspace2/apps/web/src/Header.tsx', 'export const Header = 2;');
    fs.addFile(
      '/workspace2/apps/web/src/App.tsx',
      'import { Header } from "./header";'
    );

    const result = dm.scanWorkspace(['/workspace1', '/workspace2'], DEFAULT_CONFIG);

    assert.strictEqual(result.scannedFileCount, 4, 'Should scan files across both workspace roots');
    assert.strictEqual(result.mismatchCount, 2, 'Should find mismatches in both workspace roots');

    const root1Diags = collection.get(
      vscode.Uri.file('/workspace1/packages/pkg-a/src/index.ts')
    );
    assert.ok(root1Diags && root1Diags.length === 1);

    const root2Diags = collection.get(
      vscode.Uri.file('/workspace2/apps/web/src/App.tsx')
    );
    assert.ok(root2Diags && root2Diags.length === 1);
  });

  it('4. workspace scan with zero findings', () => {
    fs.addFile('/project/src/Button.tsx', 'export const Button = 1;');
    fs.addFile('/project/src/index.ts', 'import { Button } from "./Button";');
    fs.addFile('/project/src/utils/math.ts', 'export const add = 2;');
    fs.addFile('/project/src/App.tsx', 'import { add } from "./utils/math";');

    const result = dm.scanWorkspace(['/project'], DEFAULT_CONFIG);

    assert.strictEqual(result.scannedFileCount, 4);
    assert.strictEqual(result.mismatchCount, 0, 'Should find 0 mismatches');

    for (const filePath of [
      '/project/src/Button.tsx',
      '/project/src/index.ts',
      '/project/src/utils/math.ts',
      '/project/src/App.tsx',
    ]) {
      const diags = collection.get(vscode.Uri.file(filePath));
      assert.ok(!diags || diags.length === 0);
    }
  });

  it('5. no workspace open', () => {
    // Calling scanWorkspace with empty array
    const emptyResult = dm.scanWorkspace([], DEFAULT_CONFIG);
    assert.strictEqual(emptyResult.scannedFileCount, 0);
    assert.strictEqual(emptyResult.mismatchCount, 0);

    // Calling command when vscode.workspace.workspaceFolders is undefined
    (vscode.workspace as any).workspaceFolders = undefined;

    let infoMessage = '';
    const origInfo = vscode.window.showInformationMessage;
    (vscode.window as any).showInformationMessage = (msg: string) => {
      infoMessage = msg;
      return Promise.resolve();
    };

    // Trigger command handler registered in extension
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
      vscode.window.showInformationMessage('Import Case Guard: No workspace folder is open.');
    }

    assert.strictEqual(
      infoMessage,
      'Import Case Guard: No workspace folder is open.',
      'Must display useful notice when no workspace folder is open'
    );

    (vscode.window as any).showInformationMessage = origInfo;
  });

  it('6. current-file scan remains scoped to the current file', () => {
    fs.addFile('/project/src/Button.tsx', 'export const Button = 1;');
    fs.addFile('/project/src/Header.tsx', 'export const Header = 2;');
    fs.addFile('/project/src/FileA.tsx', 'import { Button } from "./button";');
    fs.addFile('/project/src/FileB.tsx', 'import { Header } from "./header";');

    // Perform scan scoped strictly to FileA.tsx
    const mismatches = dm.scanFile('/project/src/FileA.tsx', DEFAULT_CONFIG, '/project');

    assert.strictEqual(mismatches.length, 1);
    const fileADiags = collection.get(vscode.Uri.file('/project/src/FileA.tsx'));
    assert.ok(fileADiags && fileADiags.length === 1);

    // FileB.tsx must not have been scanned or received diagnostics
    const fileBDiags = collection.get(vscode.Uri.file('/project/src/FileB.tsx'));
    assert.strictEqual(
      fileBDiags,
      undefined,
      'FileB.tsx must not have any diagnostics populated by a current-file scan of FileA.tsx'
    );
  });

  it('7. workspace scan does not modify files', () => {
    const originalContentA = 'import { Button } from "./button";\nconst a = 1;';
    const originalContentB = 'export const Button = () => null;';

    fs.addFile('/project/src/index.ts', originalContentA);
    fs.addFile('/project/src/Button.tsx', originalContentB);

    dm.scanWorkspace(['/project'], DEFAULT_CONFIG);

    const postContentA = fs.readFile('/project/src/index.ts');
    const postContentB = fs.readFile('/project/src/Button.tsx');

    assert.strictEqual(postContentA, originalContentA, 'index.ts must not be modified');
    assert.strictEqual(postContentB, originalContentB, 'Button.tsx must not be modified');
  });

  it('8. duplicate diagnostics are avoided', () => {
    fs.addFile('/project/src/Button.tsx', 'export const Button = 1;');
    fs.addFile('/project/src/index.ts', 'import { Button } from "./button";');

    // First workspace scan
    const res1 = dm.scanWorkspace(['/project'], DEFAULT_CONFIG);
    assert.strictEqual(res1.mismatchCount, 1);

    const diags1 = collection.get(vscode.Uri.file('/project/src/index.ts'));
    assert.ok(diags1 && diags1.length === 1);

    // Second workspace scan
    const res2 = dm.scanWorkspace(['/project'], DEFAULT_CONFIG);
    assert.strictEqual(res2.mismatchCount, 1);

    const diags2 = collection.get(vscode.Uri.file('/project/src/index.ts'));
    assert.strictEqual(
      diags2?.length,
      1,
      'Subsequent workspace scan must replace, not duplicate, existing diagnostics'
    );

    // Third scan via single file
    dm.scanFile('/project/src/index.ts', DEFAULT_CONFIG, '/project');
    const diags3 = collection.get(vscode.Uri.file('/project/src/index.ts'));
    assert.strictEqual(
      diags3?.length,
      1,
      'Single-file scan after workspace scan must not produce duplicate diagnostics'
    );
  });
});
