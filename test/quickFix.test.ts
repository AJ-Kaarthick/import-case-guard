import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as vscode from 'vscode';
import { scanImports } from '../src/scanner/importScanner';
import { resolveAndValidateImport } from '../src/resolver/pathResolver';
import { MockFileSystem } from '../src/resolver/fileSystem';
import { DirectoryCache } from '../src/resolver/cache';
import { ImportCaseCodeActionProvider } from '../src/providers/codeActionProvider';
import { DiagnosticManager, DIAGNOSTIC_CODE } from '../src/providers/diagnosticManager';
import { DEFAULT_CONFIG } from '../src/config';

function createMockDocument(fsPath: string, content: string) {
  return {
    uri: vscode.Uri.file(fsPath),
    languageId: 'typescript',
    getText: (range?: vscode.Range) => {
      if (!range) return content;
      const lines = content.split('\n');
      const line = lines[range.start.line] || '';
      return line.slice(range.start.character, range.end.character);
    },
  } as vscode.TextDocument;
}

describe('Quick Fix Behavior & Preservation Tests', () => {
  it('1. single finding → Fix this import', () => {
    const fs = new MockFileSystem();
    fs.addFile('/src/components/Button.tsx', 'export const Button = 1;');

    const collection = vscode.languages.createDiagnosticCollection('test-1');
    const dm = new DiagnosticManager(collection, fs);
    const provider = new ImportCaseCodeActionProvider(dm);

    const docContent = 'import Button from "./components/button";';
    const doc = createMockDocument('/src/index.ts', docContent);
    const mismatches = dm.scanFile('/src/index.ts', DEFAULT_CONFIG, '/src', docContent);
    assert.strictEqual(mismatches.length, 1);

    const diag = new vscode.Diagnostic(
      mismatches[0].range,
      mismatches[0].diagnostic.message,
      vscode.DiagnosticSeverity.Warning
    );
    diag.code = DIAGNOSTIC_CODE;

    const actions = provider.provideCodeActions(
      doc,
      mismatches[0].range,
      { diagnostics: [diag] } as any,
      {} as any
    );

    assert.strictEqual(actions.length, 1, 'Only individual Quick Fix should be returned');
    assert.strictEqual(actions[0].title, "Correct import casing to './components/Button'");
    assert.strictEqual(actions[0].isPreferred, true);
    assert.ok(actions[0].edit, 'Should contain WorkspaceEdit');
  });

  it('2. multiple findings → Fix all in current file appears', () => {
    const fs = new MockFileSystem();
    fs.addFile('/src/components/Button.tsx', 'export const Button = 1;');
    fs.addFile('/src/components/Header.tsx', 'export const Header = 2;');

    const collection = vscode.languages.createDiagnosticCollection('test-2');
    const dm = new DiagnosticManager(collection, fs);
    const provider = new ImportCaseCodeActionProvider(dm);

    const docContent = 'import Button from "./components/button";\nimport Header from "./components/header";';
    const doc = createMockDocument('/src/index.ts', docContent);
    const mismatches = dm.scanFile('/src/index.ts', DEFAULT_CONFIG, '/src', docContent);
    assert.strictEqual(mismatches.length, 2);

    const diag0 = new vscode.Diagnostic(
      mismatches[0].range,
      mismatches[0].diagnostic.message,
      vscode.DiagnosticSeverity.Warning
    );
    diag0.code = DIAGNOSTIC_CODE;

    const actions = provider.provideCodeActions(
      doc,
      mismatches[0].range,
      { diagnostics: [diag0] } as any,
      {} as any
    );

    assert.strictEqual(actions.length, 2);
    assert.strictEqual(actions[0].title, "Correct import casing to './components/Button'");
    assert.strictEqual(actions[1].title, 'Fix all 2 import casing issues in this file');
    assert.strictEqual(actions[1].command?.command, 'import-case-guard.fixAllInFile');
  });

  it('3. multiple findings → correct dynamic count', () => {
    const fs = new MockFileSystem();
    fs.addFile('/src/components/Button.tsx', 'export const Button = 1;');
    fs.addFile('/src/components/Header.tsx', 'export const Header = 2;');
    fs.addFile('/src/components/Footer.tsx', 'export const Footer = 3;');

    const collection = vscode.languages.createDiagnosticCollection('test-3');
    const dm = new DiagnosticManager(collection, fs);
    const provider = new ImportCaseCodeActionProvider(dm);

    const docContent =
      'import Button from "./components/button";\nimport Header from "./components/header";\nimport Footer from "./components/footer";';
    const doc = createMockDocument('/src/index.ts', docContent);
    const mismatches = dm.scanFile('/src/index.ts', DEFAULT_CONFIG, '/src', docContent);
    assert.strictEqual(mismatches.length, 3);

    const diag = new vscode.Diagnostic(
      mismatches[0].range,
      mismatches[0].diagnostic.message,
      vscode.DiagnosticSeverity.Warning
    );
    diag.code = DIAGNOSTIC_CODE;

    const actions = provider.provideCodeActions(
      doc,
      mismatches[0].range,
      { diagnostics: [diag] } as any,
      {} as any
    );

    assert.strictEqual(actions.length, 2);
    assert.strictEqual(actions[1].title, 'Fix all 3 import casing issues in this file');
  });

  it('4. workspace findings → Fix all in workspace appears', () => {
    const fs = new MockFileSystem();
    fs.addFile('/src/components/Button.tsx', 'export const Button = 1;');
    fs.addFile('/src/components/Header.tsx', 'export const Header = 2;');
    fs.addFile('/src/components/Footer.tsx', 'export const Footer = 3;');

    const collection = vscode.languages.createDiagnosticCollection('test-4');
    const dm = new DiagnosticManager(collection, fs);
    const provider = new ImportCaseCodeActionProvider(dm);

    const doc1Content = 'import Button from "./components/button";\nimport Header from "./components/header";';
    const doc2Content = 'import Footer from "./components/footer";';

    const doc1 = createMockDocument('/src/file1.ts', doc1Content);
    dm.scanFile('/src/file1.ts', DEFAULT_CONFIG, '/src', doc1Content);
    dm.scanFile('/src/file2.ts', DEFAULT_CONFIG, '/src', doc2Content);

    const mismatches1 = dm.getMismatchesForDocument(doc1.uri);
    assert.strictEqual(mismatches1.length, 2);
    assert.strictEqual(dm.getTotalFixableCountInWorkspace(), 3);

    const diag = new vscode.Diagnostic(
      mismatches1[0].range,
      mismatches1[0].diagnostic.message,
      vscode.DiagnosticSeverity.Warning
    );
    diag.code = DIAGNOSTIC_CODE;

    const actions = provider.provideCodeActions(
      doc1,
      mismatches1[0].range,
      { diagnostics: [diag] } as any,
      {} as any
    );

    assert.strictEqual(actions.length, 3, 'Must offer single fix, file bulk fix, and workspace bulk fix');
    assert.strictEqual(actions[0].title, "Correct import casing to './components/Button'");
    assert.strictEqual(actions[1].title, 'Fix all 2 import casing issues in this file');
    assert.strictEqual(actions[2].title, 'Fix all 3 import casing issues in workspace');
    assert.strictEqual(actions[2].command?.command, 'import-case-guard.fixAllInWorkspace');
  });

  it('5. single finding → avoid redundant file/workspace actions if appropriate', () => {
    const fs = new MockFileSystem();
    fs.addFile('/src/components/Button.tsx', 'export const Button = 1;');

    const collection = vscode.languages.createDiagnosticCollection('test-5');
    const dm = new DiagnosticManager(collection, fs);
    const provider = new ImportCaseCodeActionProvider(dm);

    const docContent = 'import Button from "./components/button";';
    const doc = createMockDocument('/src/index.ts', docContent);
    const mismatches = dm.scanFile('/src/index.ts', DEFAULT_CONFIG, '/src', docContent);
    assert.strictEqual(mismatches.length, 1);
    assert.strictEqual(dm.getTotalFixableCountInWorkspace(), 1);

    const diag = new vscode.Diagnostic(
      mismatches[0].range,
      mismatches[0].diagnostic.message,
      vscode.DiagnosticSeverity.Warning
    );
    diag.code = DIAGNOSTIC_CODE;

    const actions = provider.provideCodeActions(
      doc,
      mismatches[0].range,
      { diagnostics: [diag] } as any,
      {} as any
    );

    // When there is only 1 issue in the file and 1 issue in the workspace,
    // neither 'Fix all in file' nor 'Fix all in workspace' should appear
    assert.strictEqual(actions.length, 1);
    assert.strictEqual(actions[0].title, "Correct import casing to './components/Button'");
    assert.strictEqual(actions.some((a) => a.title.includes('Fix all')), false);
  });

  it('6. ambiguous finding → no unsafe fix', () => {
    const fs = new MockFileSystem();
    fs.addFile('/src/components/Button.tsx', 'export const Button = 1;');
    fs.addFile('/src/components/button.tsx', 'export const Button = 2;');

    const collection = vscode.languages.createDiagnosticCollection('test-6');
    const dm = new DiagnosticManager(collection, fs);
    const provider = new ImportCaseCodeActionProvider(dm);

    const docContent = 'import Button from "./components/BUTTON";';
    const doc = createMockDocument('/src/index.ts', docContent);
    const mismatches = dm.scanFile('/src/index.ts', DEFAULT_CONFIG, '/src', docContent);
    assert.strictEqual(mismatches.length, 1);
    assert.strictEqual(mismatches[0].diagnostic.isAmbiguous, true);

    const diag = new vscode.Diagnostic(
      mismatches[0].range,
      mismatches[0].diagnostic.message,
      vscode.DiagnosticSeverity.Warning
    );
    diag.code = DIAGNOSTIC_CODE;

    const actions = provider.provideCodeActions(
      doc,
      mismatches[0].range,
      { diagnostics: [diag] } as any,
      {} as any
    );

    assert.strictEqual(actions.length, 0, 'No Quick Fix must be offered for ambiguous matches');
  });

  it('7. stale range → rejected', () => {
    const fs = new MockFileSystem();
    fs.addFile('/src/components/Button.tsx', 'export const Button = 1;');

    const collection = vscode.languages.createDiagnosticCollection('test-7');
    const dm = new DiagnosticManager(collection, fs);
    const provider = new ImportCaseCodeActionProvider(dm);

    let documentContent = 'import Button from "./components/button";';
    const doc = {
      uri: vscode.Uri.file('/src/index.ts'),
      languageId: 'typescript',
      getText: (range?: vscode.Range) => {
        if (!range) return documentContent;
        const lines = documentContent.split('\n');
        const line = lines[range.start.line] || '';
        return line.slice(range.start.character, range.end.character);
      },
    } as vscode.TextDocument;

    const mismatches = dm.scanFile('/src/index.ts', DEFAULT_CONFIG, '/src', documentContent);
    assert.strictEqual(mismatches.length, 1);

    const diag = new vscode.Diagnostic(
      mismatches[0].range,
      mismatches[0].diagnostic.message,
      vscode.DiagnosticSeverity.Warning
    );
    diag.code = DIAGNOSTIC_CODE;

    // Shift text before rescanning
    documentContent = '// New comment inserted\nconst x = 123;\n' + documentContent;

    const staleActions = provider.provideCodeActions(
      doc,
      mismatches[0].range,
      { diagnostics: [diag] } as any,
      {} as any
    );

    assert.strictEqual(
      staleActions.length,
      0,
      'Stale Quick Fix must be safely rejected when text under range has shifted'
    );
  });

  it('8. no-op → rejected', () => {
    const fs = new MockFileSystem();
    fs.addFile('/src/components/Button.tsx', 'export const Button = 1;');

    const collection = vscode.languages.createDiagnosticCollection('test-8');
    const dm = new DiagnosticManager(collection, fs);
    const provider = new ImportCaseCodeActionProvider(dm);

    // Exact casing matching disk
    const docContent = 'import Button from "./components/Button";';
    const doc = createMockDocument('/src/index.ts', docContent);
    const mismatches = dm.scanFile('/src/index.ts', DEFAULT_CONFIG, '/src', docContent);

    assert.strictEqual(mismatches.length, 0, 'No mismatches generated for exact match');

    // Even if artificially invoked with a range
    const dummyRange = new vscode.Range(0, 19, 0, 39);
    const actions = provider.provideCodeActions(
      doc,
      dummyRange,
      { diagnostics: [] } as any,
      {} as any
    );

    assert.strictEqual(actions.length, 0, 'No Quick Fix offered for matching casing (no-op)');
  });

  it('9. should preserve single quotes and surrounding syntax', () => {
    const fs = new MockFileSystem();
    fs.addFile('/src/components/Button.tsx');

    const source = `import Button from './components/button'; // Comment\nconst a = 1;`;
    const imports = scanImports(source);
    assert.strictEqual(imports.length, 1);

    const imp = imports[0];
    const diag = resolveAndValidateImport('/src/index.ts', imp.rawSpecifier, fs, new DirectoryCache());
    assert.notStrictEqual(diag, null);
    assert.strictEqual(diag?.correctedSpecifier, './components/Button');

    const fixed =
      source.slice(0, imp.startOffset) +
      diag?.correctedSpecifier +
      source.slice(imp.endOffset);

    assert.strictEqual(fixed, `import Button from './components/Button'; // Comment\nconst a = 1;`);
  });

  it('10. should preserve double quotes and formatting', () => {
    const fs = new MockFileSystem();
    fs.addFile('/src/components/Button.tsx');

    const source = `import   Button   from   "./components/button"   ;`;
    const imports = scanImports(source);
    const imp = imports[0];
    const diag = resolveAndValidateImport('/src/index.ts', imp.rawSpecifier, fs, new DirectoryCache());

    const fixed =
      source.slice(0, imp.startOffset) +
      diag?.correctedSpecifier +
      source.slice(imp.endOffset);

    assert.strictEqual(fixed, `import   Button   from   "./components/Button"   ;`);
  });

  it('11. should preserve backticks in static template literal require()', () => {
    const fs = new MockFileSystem();
    fs.addFile('/src/components/Button.tsx');

    const source = 'const b = require(`./components/button`);';
    const imports = scanImports(source);
    const imp = imports[0];
    const diag = resolveAndValidateImport('/src/index.ts', imp.rawSpecifier, fs, new DirectoryCache());

    const fixed =
      source.slice(0, imp.startOffset) +
      diag?.correctedSpecifier +
      source.slice(imp.endOffset);

    assert.strictEqual(fixed, 'const b = require(`./components/Button`);');
  });

  it('12. should never rename or touch files on disk during analysis and Quick Fix', () => {
    const fs = new MockFileSystem();
    fs.addFile('/src/components/Button.tsx');

    const source = `import Button from "./components/button";`;
    const imports = scanImports(source);
    const imp = imports[0];
    resolveAndValidateImport('/src/index.ts', imp.rawSpecifier, fs, new DirectoryCache());

    const entries = fs.readDir('/src/components');
    assert.strictEqual(entries.length, 1);
    assert.strictEqual(entries[0].name, 'Button.tsx');
  });
});
