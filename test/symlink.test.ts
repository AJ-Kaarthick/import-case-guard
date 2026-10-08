import { describe, it, before, after } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { resolveAndValidateImport } from '../src/resolver/pathResolver';
import { NodeFileSystem, MockFileSystem } from '../src/resolver/fileSystem';
import { DirectoryCache } from '../src/resolver/cache';

describe('Symlink Resolution Tests', () => {
  describe('MockFileSystem Symlink Tests', () => {
    it('1. should resolve symlinked file with correct casing', () => {
      const mockFs = new MockFileSystem();
      mockFs.addFile('/project/shared/Button.tsx');
      // Create symlink: /project/src/components/Button.tsx -> /project/shared/Button.tsx
      mockFs.addSymlink('/project/src/components/Button.tsx', '/project/shared/Button.tsx');

      const result = resolveAndValidateImport(
        '/project/src/index.ts',
        './components/Button',
        mockFs,
        new DirectoryCache()
      );
      assert.strictEqual(result, null, 'Exact casing through symlink should have no diagnostic');
    });

    it('2. should detect wrong casing on symlinked file', () => {
      const mockFs = new MockFileSystem();
      mockFs.addFile('/project/shared/Button.tsx');
      mockFs.addSymlink('/project/src/components/Button.tsx', '/project/shared/Button.tsx');

      const result = resolveAndValidateImport(
        '/project/src/index.ts',
        './components/button',
        mockFs,
        new DirectoryCache()
      );
      assert.notStrictEqual(result, null);
      assert.strictEqual(result?.correctedSpecifier, './components/Button');
    });

    it('3. should resolve symlinked directory and detect wrong file casing', () => {
      const mockFs = new MockFileSystem();
      mockFs.addFile('/project/packages/ui/Card.tsx');
      // Symlink directory: /project/src/components -> /project/packages/ui
      mockFs.addSymlink('/project/src/components', '/project/packages/ui');

      const result = resolveAndValidateImport(
        '/project/src/index.ts',
        './components/card',
        mockFs,
        new DirectoryCache()
      );
      assert.notStrictEqual(result, null);
      assert.strictEqual(result?.correctedSpecifier, './components/Card');
    });

    it('4. should detect wrong casing on the symlinked directory itself', () => {
      const mockFs = new MockFileSystem();
      mockFs.addFile('/project/packages/ui/Card.tsx');
      // Symlink directory named 'Components' with capital C
      mockFs.addSymlink('/project/src/Components', '/project/packages/ui');

      const result = resolveAndValidateImport(
        '/project/src/index.ts',
        './components/Card',
        mockFs,
        new DirectoryCache()
      );
      assert.notStrictEqual(result, null);
      assert.strictEqual(result?.correctedSpecifier, './Components/Card');
    });

    it('5. broken symlink should fail safely without casing diagnostic', () => {
      const mockFs = new MockFileSystem();
      // Broken symlink pointing to non-existent target
      mockFs.addSymlink('/project/src/components/Broken.tsx', '/project/shared/NonExistent.tsx');

      const result = resolveAndValidateImport(
        '/project/src/index.ts',
        './components/broken',
        mockFs,
        new DirectoryCache()
      );
      assert.strictEqual(result, null, 'Broken symlink must fail safely');
    });
  });

  describe('Real Disk Symlink Tests (Linux Real I/O)', () => {
    let tempDir: string;
    let nodeFs: NodeFileSystem;
    let cache: DirectoryCache;

    before(() => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'symlink-test-'));
      nodeFs = new NodeFileSystem();
      cache = new DirectoryCache();

      // Tree:
      // tempDir/
      //   shared/
      //     Header.tsx
      //   packages/
      //     ui/
      //       Footer.tsx
      //   src/
      //     components/ (symlink to packages/ui)
      //     Header.tsx (symlink to shared/Header.tsx)
      //     Broken.tsx (broken symlink)
      //     index.ts
      const sharedDir = path.join(tempDir, 'shared');
      const uiDir = path.join(tempDir, 'packages', 'ui');
      const srcDir = path.join(tempDir, 'src');

      fs.mkdirSync(sharedDir, { recursive: true });
      fs.mkdirSync(uiDir, { recursive: true });
      fs.mkdirSync(srcDir, { recursive: true });

      fs.writeFileSync(path.join(sharedDir, 'Header.tsx'), 'export const Header = () => null;');
      fs.writeFileSync(path.join(uiDir, 'Footer.tsx'), 'export const Footer = () => null;');
      fs.writeFileSync(path.join(srcDir, 'index.ts'), 'export const App = 1;');

      // Create symlinks
      try {
        fs.symlinkSync(path.join(sharedDir, 'Header.tsx'), path.join(srcDir, 'Header.tsx'));
        fs.symlinkSync(uiDir, path.join(srcDir, 'components'), 'dir');
        fs.symlinkSync(path.join(tempDir, 'does-not-exist.tsx'), path.join(srcDir, 'Broken.tsx'));
      } catch (err) {
        // In restricted environments where symlinks might not be allowed
        console.warn('Could not create real disk symlinks:', err);
      }
    });

    after(() => {
      if (tempDir && fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it('6. real disk: symlinked file wrong casing detected', () => {
      const symlinkFile = path.join(tempDir, 'src', 'Header.tsx');
      if (!fs.existsSync(symlinkFile)) return; // skip if symlinks not supported

      const importer = path.join(tempDir, 'src', 'index.ts');
      const res = resolveAndValidateImport(importer, './header', nodeFs, cache);
      assert.notStrictEqual(res, null);
      assert.strictEqual(res?.correctedSpecifier, './Header');
    });

    it('7. real disk: symlinked directory traversal and casing detected', () => {
      const symlinkDir = path.join(tempDir, 'src', 'components');
      if (!fs.existsSync(symlinkDir)) return;

      const importer = path.join(tempDir, 'src', 'index.ts');
      const res = resolveAndValidateImport(importer, './components/footer', nodeFs, cache);
      assert.notStrictEqual(res, null);
      assert.strictEqual(res?.correctedSpecifier, './components/Footer');
    });

    it('8. real disk: broken symlink fails safely without false positive', () => {
      const importer = path.join(tempDir, 'src', 'index.ts');
      const res = resolveAndValidateImport(importer, './broken', nodeFs, cache);
      assert.strictEqual(res, null);
    });
  });
});
