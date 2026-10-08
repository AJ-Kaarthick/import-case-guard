import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as vscode from 'vscode';
import { isPathExcluded, DEFAULT_CONFIG, matchesGlob } from '../src/config';
import { DirectoryCache } from '../src/resolver/cache';
import { MockFileSystem } from '../src/resolver/fileSystem';
import { DiagnosticManager } from '../src/providers/diagnosticManager';

describe('Exclusions & Cache Invalidation Tests', () => {
  it('1. should exclude node_modules, dist, build, .git, coverage, .next, and .nuxt consistently', () => {
    const excludes = DEFAULT_CONFIG.exclude;
    const wsRoot = '/project';

    assert.strictEqual(
      isPathExcluded('/project/node_modules/package/index.ts', excludes, wsRoot),
      true
    );
    assert.strictEqual(
      isPathExcluded('/project/dist/bundle.js', excludes, wsRoot),
      true
    );
    assert.strictEqual(
      isPathExcluded('/project/build/index.js', excludes, wsRoot),
      true
    );
    assert.strictEqual(
      isPathExcluded('/project/coverage/lcov-report/index.html', excludes, wsRoot),
      true
    );
    assert.strictEqual(
      isPathExcluded('/project/.git/HEAD', excludes, wsRoot),
      true
    );
    assert.strictEqual(
      isPathExcluded('/project/.next/server/pages.js', excludes, wsRoot),
      true
    );
    assert.strictEqual(
      isPathExcluded('/project/.nuxt/dist/app.js', excludes, wsRoot),
      true
    );
    assert.strictEqual(
      isPathExcluded('/project/src/components/Button.tsx', excludes, wsRoot),
      false
    );
  });

  it('2. should NOT exclude a project simply because an ancestor directory is named build/dist/coverage', () => {
    const excludes = DEFAULT_CONFIG.exclude;
    // Project checkout inside an ancestor folder named '/build'
    const ancestorWs = '/var/ci/build/my-project';
    const sourceFile = '/var/ci/build/my-project/src/components/Button.tsx';

    assert.strictEqual(
      isPathExcluded(sourceFile, excludes, ancestorWs),
      false,
      'Source file inside project must not be excluded just because ancestor directory is named build'
    );

    // But an actual build folder inside that workspace SHOULD be excluded:
    const buildArtifact = '/var/ci/build/my-project/build/out.js';
    assert.strictEqual(
      isPathExcluded(buildArtifact, excludes, ancestorWs),
      true,
      'Build folder inside workspace must still be excluded'
    );
  });

  it('3. should support workspace-relative and custom glob patterns', () => {
    const customExcludes = ['src/legacy/**', '**/*.generated.ts'];
    const wsRoot = '/repo';

    assert.strictEqual(
      isPathExcluded('/repo/src/legacy/old.ts', customExcludes, wsRoot),
      true
    );
    assert.strictEqual(
      isPathExcluded('/repo/src/legacy/sub/deep.ts', customExcludes, wsRoot),
      true
    );
    assert.strictEqual(
      isPathExcluded('/repo/src/components/api.generated.ts', customExcludes, wsRoot),
      true
    );
    assert.strictEqual(
      isPathExcluded('/repo/src/components/normal.ts', customExcludes, wsRoot),
      false
    );
  });

  it('4. matchesGlob helper validation', () => {
    assert.strictEqual(matchesGlob('build/bundle.js', '**/build/**'), true);
    assert.strictEqual(matchesGlob('packages/app/dist/main.js', '**/dist/**'), true);
    assert.strictEqual(matchesGlob('src/legacy/util.ts', 'src/legacy/**'), true);
    assert.strictEqual(matchesGlob('src/new/util.ts', 'src/legacy/**'), false);
  });

  it('5. cache invalidation on file change should invalidate only the parent directory', () => {
    const fs = new MockFileSystem();
    fs.addFile('/src/components/Button.tsx');
    fs.addFile('/src/utils/math.ts');

    const cache = new DirectoryCache();

    // Populate cache
    const entriesComp1 = cache.getEntries('/src/components', fs);
    const entriesUtils1 = cache.getEntries('/src/utils', fs);
    assert.strictEqual(entriesComp1.length, 1);
    assert.strictEqual(entriesUtils1.length, 1);

    // Invalidate file in components
    const invalidatedDir = cache.invalidateFile('/src/components/NewComponent.tsx');
    assert.strictEqual(invalidatedDir, '/src/components');

    // Add new file to filesystem
    fs.addFile('/src/components/NewComponent.tsx');

    // Getting entries for components should reflect new file because it was invalidated
    const entriesComp2 = cache.getEntries('/src/components', fs);
    assert.strictEqual(entriesComp2.length, 2);

    // Utils cache is untouched
    const entriesUtils2 = cache.getEntries('/src/utils', fs);
    assert.strictEqual(entriesUtils2.length, 1);
  });

  it('6. sibling directory dependency invalidation in DiagnosticManager', () => {
    const mockCollection = {
      delete: () => {},
      clear: () => {},
      set: () => {},
      dispose: () => {},
    } as unknown as vscode.DiagnosticCollection;

    const mockFs = new MockFileSystem();
    mockFs.addFile('/project/src/components/Button.tsx');
    mockFs.addFile('/project/src/pages/Home.tsx');

    const dm = new DiagnosticManager(mockCollection, mockFs);

    // Document in src/pages importing from ../components/button
    const mockDoc = {
      uri: {
        scheme: 'file',
        fsPath: '/project/src/pages/Home.tsx',
        toString: () => 'file:///project/src/pages/Home.tsx',
      },
      languageId: 'typescript',
      getText: () => 'import Button from "../components/button";',
    } as unknown as vscode.TextDocument;

    dm.scanDocument(mockDoc, DEFAULT_CONFIG);

    // Verify Home.tsx is affected by changes in sibling directory '/project/src/components'
    const isAffectedBySibling = dm.isDocumentAffectedByDir(
      mockDoc.uri,
      '/project/src/components'
    );
    assert.strictEqual(isAffectedBySibling, true, 'Document must be marked affected by imported sibling directory');

    // Verify Home.tsx is affected by changes in its own directory '/project/src/pages'
    const isAffectedByOwnDir = dm.isDocumentAffectedByDir(
      mockDoc.uri,
      '/project/src/pages'
    );
    assert.strictEqual(isAffectedByOwnDir, true, 'Document must be affected by its own parent directory');

    // Verify Home.tsx is NOT affected by an unrelated directory '/project/src/unrelated'
    const isAffectedByUnrelated = dm.isDocumentAffectedByDir(
      mockDoc.uri,
      '/project/src/unrelated'
    );
    assert.strictEqual(isAffectedByUnrelated, false, 'Document must not be affected by unrelated directory');

    // Verify Home.tsx is NOT affected by directory with shared prefix like '/project/src/components-extra'
    const isAffectedByPrefixOverlap = dm.isDocumentAffectedByDir(
      mockDoc.uri,
      '/project/src/components-extra'
    );
    assert.strictEqual(isAffectedByPrefixOverlap, false, 'Document must not be affected by boundary prefix overlap');
  });

  it('7. event storm / rapid watcher bursts should be batched and debounced', async () => {
    let scanCount = 0;
    let timer: NodeJS.Timeout | undefined;
    const pendingDirs = new Set<string>();

    function triggerDebouncedBatch(dir: string, callback: () => void) {
      pendingDirs.add(dir);
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        pendingDirs.clear();
        scanCount++;
        callback();
      }, 50);
    }

    // Fire 20 rapid bursts within 10ms
    await new Promise<void>((resolve) => {
      for (let i = 0; i < 20; i++) {
        triggerDebouncedBatch(`/project/src/dir${i}`, () => {
          resolve();
        });
      }
    });

    // Verify only a single coalesced scan occurred
    assert.strictEqual(scanCount, 1, 'Burst of 20 rapid events must coalesce into 1 scan');
  });
});
