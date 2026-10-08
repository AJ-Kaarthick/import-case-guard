import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { resolveAndValidateImport } from '../src/resolver/pathResolver';
import { MockFileSystem } from '../src/resolver/fileSystem';
import { DirectoryCache } from '../src/resolver/cache';

describe('Multi-Root Workspace Resolution Tests', () => {
  it('should resolve imports relative to document directory across distinct workspace roots', () => {
    const fs = new MockFileSystem();
    const cache = new DirectoryCache();

    // Setup Workspace Root A
    fs.addFile('/workspaces/frontend/src/components/Header.tsx');
    fs.addFile('/workspaces/frontend/src/App.tsx');

    // Setup Workspace Root B
    fs.addFile('/workspaces/backend/src/routes/Auth.ts');
    fs.addFile('/workspaces/backend/src/server.ts');

    // Test resolution in Workspace Root A
    const resultA = resolveAndValidateImport(
      '/workspaces/frontend/src/App.tsx',
      './components/header',
      fs,
      cache
    );
    assert.notStrictEqual(resultA, null);
    assert.strictEqual(resultA?.correctedSpecifier, './components/Header');

    // Test resolution in Workspace Root B
    const resultB = resolveAndValidateImport(
      '/workspaces/backend/src/server.ts',
      './routes/auth',
      fs,
      cache
    );
    assert.notStrictEqual(resultB, null);
    assert.strictEqual(resultB?.correctedSpecifier, './routes/Auth');

    // Test exact match in Workspace Root A
    const resultAExact = resolveAndValidateImport(
      '/workspaces/frontend/src/App.tsx',
      './components/Header',
      fs,
      cache
    );
    assert.strictEqual(resultAExact, null);
  });
});
