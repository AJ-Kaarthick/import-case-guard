import { describe, it, beforeEach } from 'node:test';
import * as assert from 'node:assert';
import { resolveAndValidateImport } from '../src/resolver/pathResolver';
import { MockFileSystem } from '../src/resolver/fileSystem';
import { DirectoryCache } from '../src/resolver/cache';

describe('Path Resolver & Case Mismatch Tests', () => {
  let fs: MockFileSystem;
  let cache: DirectoryCache;

  beforeEach(() => {
    fs = new MockFileSystem();
    cache = new DirectoryCache();
  });

  it('1. Correct casing → no diagnostic', () => {
    fs.addFile('/project/src/components/Button.tsx');
    const result = resolveAndValidateImport(
      '/project/src/index.ts',
      './components/Button',
      fs,
      cache
    );
    assert.strictEqual(result, null);
  });

  it('2. Wrong file casing → diagnostic with corrected path', () => {
    fs.addFile('/project/src/components/Button.tsx');
    const result = resolveAndValidateImport(
      '/project/src/index.ts',
      './components/button',
      fs,
      cache
    );
    assert.notStrictEqual(result, null);
    assert.strictEqual(result?.hasMismatch, true);
    assert.strictEqual(result?.isAmbiguous, false);
    assert.strictEqual(result?.correctedSpecifier, './components/Button');
    assert.strictEqual(result?.originalSpecifier, './components/button');
  });

  it('3. Wrong directory casing → diagnostic with corrected path', () => {
    fs.addFile('/project/src/components/Button.tsx');
    const result = resolveAndValidateImport(
      '/project/src/index.ts',
      './Components/Button',
      fs,
      cache
    );
    assert.notStrictEqual(result, null);
    assert.strictEqual(result?.hasMismatch, true);
    assert.strictEqual(result?.isAmbiguous, false);
    assert.strictEqual(result?.correctedSpecifier, './components/Button');
  });

  it('4. Multiple wrong path segments (User correction 7: disk src/Components/Button.tsx and import "./components/button")', () => {
    fs.addFile('/project/src/Components/Button.tsx');
    const result = resolveAndValidateImport(
      '/project/src/index.ts',
      './components/button',
      fs,
      cache
    );
    assert.notStrictEqual(result, null);
    assert.strictEqual(result?.hasMismatch, true);
    assert.strictEqual(result?.isAmbiguous, false);
    assert.strictEqual(result?.correctedSpecifier, './Components/Button');
  });

  it('5. Extensionless import resolution', () => {
    fs.addFile('/project/src/utils/math.ts');
    const result = resolveAndValidateImport(
      '/project/src/index.ts',
      './utils/Math',
      fs,
      cache
    );
    assert.notStrictEqual(result, null);
    assert.strictEqual(result?.correctedSpecifier, './utils/math');
  });

  it('6. Explicit extension import with wrong casing', () => {
    fs.addFile('/project/src/components/Button.tsx');
    const result = resolveAndValidateImport(
      '/project/src/index.ts',
      './components/button.tsx',
      fs,
      cache
    );
    assert.notStrictEqual(result, null);
    assert.strictEqual(result?.correctedSpecifier, './components/Button.tsx');
  });

  it('7. Directory index resolution: ./utils -> utils/index.ts', () => {
    fs.addFile('/project/src/Utils/index.ts');
    // Wrong directory casing
    const result = resolveAndValidateImport(
      '/project/src/index.ts',
      './utils',
      fs,
      cache
    );
    assert.notStrictEqual(result, null);
    assert.strictEqual(result?.correctedSpecifier, './Utils');
  });

  it('8. Explicit index file casing: ./utils/Index.ts -> ./utils/index.ts', () => {
    fs.addFile('/project/src/utils/index.ts');
    const result = resolveAndValidateImport(
      '/project/src/index.ts',
      './utils/Index.ts',
      fs,
      cache
    );
    assert.notStrictEqual(result, null);
    assert.strictEqual(result?.correctedSpecifier, './utils/index.ts');
  });

  it('9. Nonexistent path → no casing diagnostic (strictly no false positives for missing files)', () => {
    fs.addFile('/project/src/components/Button.tsx');
    const result = resolveAndValidateImport(
      '/project/src/index.ts',
      './components/DoesNotExist',
      fs,
      cache
    );
    assert.strictEqual(result, null);

    const result2 = resolveAndValidateImport(
      '/project/src/index.ts',
      './nonexistentDir/file',
      fs,
      cache
    );
    assert.strictEqual(result2, null);
  });

  it('10. Windows-style backslash paths', () => {
    fs.addFile('/project/src/components/Button.tsx');
    const result = resolveAndValidateImport(
      '/project/src/index.ts',
      '.\\components\\button',
      fs,
      cache
    );
    assert.notStrictEqual(result, null);
    assert.strictEqual(result?.correctedSpecifier, '.\\components\\Button');
  });

  it('11. Paths with spaces and mixed case', () => {
    fs.addFile('/project/src/My Components/Custom Button.tsx');
    const result = resolveAndValidateImport(
      '/project/src/index.ts',
      './my components/custom button',
      fs,
      cache
    );
    assert.notStrictEqual(result, null);
    assert.strictEqual(result?.correctedSpecifier, './My Components/Custom Button');
  });

  it('12. Mixed-case file names (iOSHelper.ts, myAPI.js)', () => {
    fs.addFile('/project/src/utils/iOSHelper.ts');
    fs.addFile('/project/src/api/myAPI.js');

    const res1 = resolveAndValidateImport(
      '/project/src/index.ts',
      './utils/ioshelper',
      fs,
      cache
    );
    assert.strictEqual(res1?.correctedSpecifier, './utils/iOSHelper');

    const res2 = resolveAndValidateImport(
      '/project/src/index.ts',
      './api/MyApi',
      fs,
      cache
    );
    assert.strictEqual(res2?.correctedSpecifier, './api/myAPI');
  });

  it('13. Ambiguous match on disk (multiple files with same lower-case name on case-sensitive fs)', () => {
    fs.addFile('/project/src/components/Button.tsx');
    fs.addFile('/project/src/components/button.tsx');

    const result = resolveAndValidateImport(
      '/project/src/index.ts',
      './components/BUTTON',
      fs,
      cache
    );
    assert.notStrictEqual(result, null);
    assert.strictEqual(result?.hasMismatch, true);
    assert.strictEqual(result?.isAmbiguous, true);
    assert.strictEqual(result?.correctedSpecifier, undefined); // No Quick Fix for ambiguous match
  });

  it('14. Nested parent directories (../../components/button)', () => {
    fs.addFile('/project/src/components/Button.tsx');
    const result = resolveAndValidateImport(
      '/project/src/features/auth/login.ts',
      '../../components/button',
      fs,
      cache
    );
    assert.notStrictEqual(result, null);
    assert.strictEqual(result?.correctedSpecifier, '../../components/Button');
  });

  it('15. REGRESSION TEST: Case-insensitive OS simulation (macOS APFS / Windows NTFS)', () => {
    // In this simulation, fs.stat returns truthy even for wrong casing (e.g. /button.tsx exists),
    // but the actual disk listing has Button.tsx.
    const caseInsensitiveFs = new MockFileSystem(true);
    caseInsensitiveFs.addFile('/project/src/components/Button.tsx');

    // Verify mock simulates case-insensitive stat behavior:
    const statWrongCase = caseInsensitiveFs.stat('/project/src/components/button.tsx');
    assert.notStrictEqual(statWrongCase, null, 'Simulated OS stat reports file as existing');

    // Our resolver must still detect the case mismatch because it inspects directory entries!
    const result = resolveAndValidateImport(
      '/project/src/index.ts',
      './components/button',
      caseInsensitiveFs,
      new DirectoryCache()
    );

    assert.notStrictEqual(result, null, 'Must detect mismatch on case-insensitive OS');
    assert.strictEqual(result?.hasMismatch, true);
    assert.strictEqual(result?.correctedSpecifier, './components/Button');
  });

  it('16. Dotted directory path: ./.storybook/main with wrong casing on disk .Storybook/main.ts', () => {
    fs.addFile('/project/src/.Storybook/main.ts');
    const result = resolveAndValidateImport(
      '/project/src/index.ts',
      './.storybook/main',
      fs,
      cache
    );
    assert.notStrictEqual(result, null);
    assert.strictEqual(result?.correctedSpecifier, './.Storybook/main');
  });

  it('17. Dotted filename: ../.eslintrc with wrong casing on disk .ESLintrc.json', () => {
    fs.addFile('/project/.ESLintrc.json');
    const result = resolveAndValidateImport(
      '/project/src/index.ts',
      '../.eslintrc.json',
      fs,
      cache
    );
    assert.notStrictEqual(result, null);
    assert.strictEqual(result?.correctedSpecifier, '../.ESLintrc.json');
  });

  it('18. Nested multiple dot-prefixed segments: ./.config/.env', () => {
    fs.addFile('/project/src/.Config/.Env.json');
    const result = resolveAndValidateImport(
      '/project/src/index.ts',
      './.config/.env.json',
      fs,
      cache
    );
    assert.notStrictEqual(result, null);
    assert.strictEqual(result?.correctedSpecifier, './.Config/.Env.json');
  });

  it('19. Dotted path exact match produces no diagnostic and never a bogus prefix', () => {
    fs.addFile('/project/src/.storybook/main.ts');
    const result = resolveAndValidateImport(
      '/project/src/index.ts',
      './.storybook/main',
      fs,
      cache
    );
    assert.strictEqual(result, null);
  });

  it('20. Safety guard: never emits a diagnostic when correctedSpecifier === originalSpecifier', () => {
    fs.addFile('/project/src/components/Button.tsx');
    const result = resolveAndValidateImport(
      '/project/src/index.ts',
      './components/Button',
      fs,
      cache
    );
    assert.strictEqual(result, null);
  });

  it('21. Ambiguous same-base extension candidates: Button.ts and Button.js on disk', () => {
    fs.addFile('/project/src/components/Button.ts');
    fs.addFile('/project/src/components/Button.js');

    const result = resolveAndValidateImport(
      '/project/src/index.ts',
      './components/button',
      fs,
      cache
    );

    assert.notStrictEqual(result, null, 'Diagnostic should still be reported');
    assert.strictEqual(result?.hasMismatch, true);
    assert.strictEqual(result?.isAmbiguous, true);
    assert.strictEqual(result?.correctedSpecifier, undefined, 'Quick Fix must be suppressed for ambiguous extension candidates');
  });
});
