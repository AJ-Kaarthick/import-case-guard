import { describe, it, before, after } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { resolveAndValidateImport } from '../src/resolver/pathResolver';
import { NodeFileSystem } from '../src/resolver/fileSystem';
import { DirectoryCache } from '../src/resolver/cache';

describe('Real Disk Filesystem Tests (Linux Real I/O)', () => {
  let tempDir: string;
  let nodeFs: NodeFileSystem;
  let cache: DirectoryCache;

  before(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'import-case-guard-test-'));
    nodeFs = new NodeFileSystem();
    cache = new DirectoryCache();

    // Create real test tree:
    // tempDir/
    //   src/
    //     Components/
    //       Button.tsx
    //     Utils/
    //       index.ts
    //     index.ts
    const srcDir = path.join(tempDir, 'src');
    const compDir = path.join(srcDir, 'Components');
    const utilsDir = path.join(srcDir, 'Utils');

    fs.mkdirSync(compDir, { recursive: true });
    fs.mkdirSync(utilsDir, { recursive: true });

    fs.writeFileSync(path.join(compDir, 'Button.tsx'), 'export const Button = () => null;');
    fs.writeFileSync(path.join(compDir, 'Modal.module.tsx'), 'export const Modal = 1;');
    fs.writeFileSync(path.join(utilsDir, 'index.ts'), 'export const util = 1;');
    fs.writeFileSync(path.join(srcDir, 'index.ts'), 'import "./Components/Button";');
    fs.writeFileSync(
      path.join(tempDir, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          baseUrl: './src',
          paths: {
            '@/*': ['*'],
            '@lib/*.module': ['Components/*.module'],
          },
        },
      })
    );
  });

  after(() => {
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('1. real disk: exact match has no diagnostic', () => {
    const importer = path.join(tempDir, 'src', 'index.ts');
    const res = resolveAndValidateImport(importer, './Components/Button', nodeFs, cache);
    assert.strictEqual(res, null);
  });

  it('2. real disk: wrong file casing detected', () => {
    const importer = path.join(tempDir, 'src', 'index.ts');
    const res = resolveAndValidateImport(importer, './Components/button', nodeFs, cache);
    assert.notStrictEqual(res, null);
    assert.strictEqual(res?.correctedSpecifier, './Components/Button');
  });

  it('3. real disk: wrong directory casing detected', () => {
    const importer = path.join(tempDir, 'src', 'index.ts');
    const res = resolveAndValidateImport(importer, './components/Button', nodeFs, cache);
    assert.notStrictEqual(res, null);
    assert.strictEqual(res?.correctedSpecifier, './Components/Button');
  });

  it('4. real disk: both directory and file wrong casing detected', () => {
    const importer = path.join(tempDir, 'src', 'index.ts');
    const res = resolveAndValidateImport(importer, './components/button', nodeFs, cache);
    assert.notStrictEqual(res, null);
    assert.strictEqual(res?.correctedSpecifier, './Components/Button');
  });

  it('5. real disk: directory index casing detected', () => {
    const importer = path.join(tempDir, 'src', 'index.ts');
    const res = resolveAndValidateImport(importer, './utils', nodeFs, cache);
    assert.notStrictEqual(res, null);
    assert.strictEqual(res?.correctedSpecifier, './Utils');
  });

  it('6. real disk: missing file has no diagnostic', () => {
    const importer = path.join(tempDir, 'src', 'index.ts');
    const res = resolveAndValidateImport(importer, './Components/NonExistent', nodeFs, cache);
    assert.strictEqual(res, null);
  });

  it('7. real disk: alias wrong file casing detected', () => {
    const importer = path.join(tempDir, 'src', 'index.ts');
    const config = {
      configFilePath: path.join(tempDir, 'tsconfig.json'),
      configDir: tempDir,
      baseUrl: './src',
      mappings: [
        {
          pattern: '@/*',
          hasWildcard: true,
          prefix: '@/',
          suffix: '',
          targets: ['*'],
          baseDir: path.join(tempDir, 'src'),
          configFilePath: path.join(tempDir, 'tsconfig.json'),
        },
      ],
      isIncomplete: false,
    };
    const res = resolveAndValidateImport(importer, '@/components/button', nodeFs, cache, config);
    assert.notStrictEqual(res, null);
    assert.strictEqual(res?.hasMismatch, true);
    assert.strictEqual(res?.correctedSpecifier, '@/Components/Button');
  });

  it('8. real disk: alias exact match has no diagnostic', () => {
    const importer = path.join(tempDir, 'src', 'index.ts');
    const config = {
      configFilePath: path.join(tempDir, 'tsconfig.json'),
      configDir: tempDir,
      baseUrl: './src',
      mappings: [
        {
          pattern: '@/*',
          hasWildcard: true,
          prefix: '@/',
          suffix: '',
          targets: ['*'],
          baseDir: path.join(tempDir, 'src'),
          configFilePath: path.join(tempDir, 'tsconfig.json'),
        },
      ],
      isIncomplete: false,
    };
    const res = resolveAndValidateImport(importer, '@/Components/Button', nodeFs, cache, config);
    assert.strictEqual(res, null);
  });

  it('9. real disk: alias with suffix casing mismatch detected', () => {
    const importer = path.join(tempDir, 'src', 'index.ts');
    const config = {
      configFilePath: path.join(tempDir, 'tsconfig.json'),
      configDir: tempDir,
      baseUrl: './src',
      mappings: [
        {
          pattern: '@lib/*.module',
          hasWildcard: true,
          prefix: '@lib/',
          suffix: '.module',
          targets: ['Components/*.module'],
          baseDir: path.join(tempDir, 'src'),
          configFilePath: path.join(tempDir, 'tsconfig.json'),
        },
      ],
      isIncomplete: false,
    };
    const res = resolveAndValidateImport(importer, '@lib/modal.module', nodeFs, cache, config);
    assert.notStrictEqual(res, null);
    assert.strictEqual(res?.hasMismatch, true);
    assert.strictEqual(res?.correctedSpecifier, '@lib/Modal.module');
  });

  it('10. real disk: alias with suffix exact match has no diagnostic', () => {
    const importer = path.join(tempDir, 'src', 'index.ts');
    const config = {
      configFilePath: path.join(tempDir, 'tsconfig.json'),
      configDir: tempDir,
      baseUrl: './src',
      mappings: [
        {
          pattern: '@lib/*.module',
          hasWildcard: true,
          prefix: '@lib/',
          suffix: '.module',
          targets: ['Components/*.module'],
          baseDir: path.join(tempDir, 'src'),
          configFilePath: path.join(tempDir, 'tsconfig.json'),
        },
      ],
      isIncomplete: false,
    };
    const res = resolveAndValidateImport(importer, '@lib/Modal.module', nodeFs, cache, config);
    assert.strictEqual(res, null);
  });
});
