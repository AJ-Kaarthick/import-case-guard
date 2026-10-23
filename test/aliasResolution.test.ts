import { describe, it, beforeEach } from "node:test";
import * as assert from "node:assert";
import * as path from "path";
import * as vscode from "vscode";
import { MockFileSystem } from "../src/resolver/fileSystem";
import { DirectoryCache } from "../src/resolver/cache";
import { resolveAndValidateImport } from "../src/resolver/pathResolver";
import {
  loadAliasConfig,
  findConfigFile,
  getMatchingMappings,
  parsePattern,
  AliasConfigManager,
} from "../src/resolver/aliasConfig";
import { DiagnosticManager, DIAGNOSTIC_CODE } from "../src/providers/diagnosticManager";
import { ImportCaseCodeActionProvider } from "../src/providers/codeActionProvider";
import { DEFAULT_CONFIG } from "../src/config";

function createMockDocument(fsPath: string, content: string) {
  return {
    uri: vscode.Uri.file(fsPath),
    languageId: "typescript",
    isClosed: false,
    getText: (range?: vscode.Range) => {
      if (!range) return content;
      const lines = content.split("\n");
      const line = lines[range.start.line] || "";
      return line.slice(range.start.character, range.end.character);
    },
  } as vscode.TextDocument;
}

describe("TypeScript & JavaScript Path Alias Casing Support Tests", () => {
  let fs: MockFileSystem;
  let cache: DirectoryCache;

  beforeEach(() => {
    (vscode.workspace as any)._resetAll();
    fs = new MockFileSystem();
    (vscode.workspace as any)._mockFs = fs;
    cache = new DirectoryCache();
  });

  describe("1. Configuration Parsing & TypeScript Semantics", () => {
    it("parses JSONC with comments and trailing commas", () => {
      fs.addFile(
        "/project/tsconfig.json",
        `{
          // Compiler settings
          "compilerOptions": {
            "baseUrl": "./src", // Base url
            "paths": {
              "@/*": ["*"], /* Wildcard mapping */
            },
          },
        }`
      );

      const config = loadAliasConfig("/project/tsconfig.json", fs);
      assert.notStrictEqual(config, null);
      assert.strictEqual(config?.isIncomplete, false);
      assert.strictEqual(config?.mappings.length, 1);
      assert.strictEqual(config?.mappings[0].pattern, "@/*");
      assert.strictEqual(config?.mappings[0].baseDir, "/project/src");
    });

    it("parses exact vs wildcard patterns accurately", () => {
      const p1 = parsePattern("@/*");
      assert.strictEqual(p1.hasWildcard, true);
      assert.strictEqual(p1.prefix, "@/");
      assert.strictEqual(p1.suffix, "");

      const p2 = parsePattern("@app");
      assert.strictEqual(p2.hasWildcard, false);
      assert.strictEqual(p2.prefix, "@app");
      assert.strictEqual(p2.suffix, "");

      const p3 = parsePattern("@lib/*.module");
      assert.strictEqual(p3.hasWildcard, true);
      assert.strictEqual(p3.prefix, "@lib/");
      assert.strictEqual(p3.suffix, ".module");
    });

    it("orders mappings: exact first, then longest prefix, then longest suffix", () => {
      const mappings = [
        { pattern: "@/*", prefix: "@/", suffix: "", hasWildcard: true, targets: ["src/*"], baseDir: "/p", configFilePath: "/p/tsconfig.json" },
        { pattern: "@components/*", prefix: "@components/", suffix: "", hasWildcard: true, targets: ["src/c/*"], baseDir: "/p", configFilePath: "/p/tsconfig.json" },
        { pattern: "@components/button", prefix: "@components/button", suffix: "", hasWildcard: false, targets: ["src/c/Button.tsx"], baseDir: "/p", configFilePath: "/p/tsconfig.json" },
        { pattern: "@components/ui/*", prefix: "@components/ui/", suffix: "", hasWildcard: true, targets: ["src/ui/*"], baseDir: "/p", configFilePath: "/p/tsconfig.json" },
      ];

      const matches = getMatchingMappings("@components/button", mappings);
      assert.strictEqual(matches[0].pattern, "@components/button"); // exact match wins

      const uiMatches = getMatchingMappings("@components/ui/Icon", mappings);
      assert.strictEqual(uiMatches[0].pattern, "@components/ui/*"); // longest prefix wins over @components/* and @/*
    });

    it("handles extends inheritance and resolves baseDir relative to originating config", () => {
      fs.addFile(
        "/repo/configs/tsconfig.base.json",
        JSON.stringify({
          compilerOptions: {
            baseUrl: "./",
            paths: {
              "@shared/*": ["shared-lib/*"],
            },
          },
        })
      );

      fs.addFile(
        "/repo/packages/app/tsconfig.json",
        JSON.stringify({
          extends: "../../configs/tsconfig.base.json",
          compilerOptions: {
            paths: {
              "@app/*": ["src/*"],
            },
          },
        })
      );

      const config = loadAliasConfig("/repo/packages/app/tsconfig.json", fs);
      assert.notStrictEqual(config, null);
      assert.strictEqual(config?.isIncomplete, false);
      assert.strictEqual(config?.mappings.length, 2);

      const sharedMapping = config?.mappings.find((m) => m.pattern === "@shared/*");
      const appMapping = config?.mappings.find((m) => m.pattern === "@app/*");

      assert.strictEqual(sharedMapping?.baseDir, "/repo/configs"); // baseDir from parent config
      assert.strictEqual(appMapping?.baseDir, "/repo/packages/app"); // baseDir from child config
    });

    it("child config overrides parent mapping for same pattern key", () => {
      fs.addFile(
        "/repo/base.json",
        JSON.stringify({
          compilerOptions: {
            paths: {
              "@ui/*": ["common-ui/*"],
            },
          },
        })
      );

      fs.addFile(
        "/repo/app/tsconfig.json",
        JSON.stringify({
          extends: "../base.json",
          compilerOptions: {
            paths: {
              "@ui/*": ["custom-ui/*"],
            },
          },
        })
      );

      const config = loadAliasConfig("/repo/app/tsconfig.json", fs);
      assert.strictEqual(config?.mappings.length, 1);
      assert.strictEqual(config?.mappings[0].targets[0], "custom-ui/*");
    });

    it("handles circular extends safely by marking config incomplete without crashing", () => {
      fs.addFile(
        "/repo/tsconfig.a.json",
        JSON.stringify({ extends: "./tsconfig.b.json" })
      );
      fs.addFile(
        "/repo/tsconfig.b.json",
        JSON.stringify({ extends: "./tsconfig.a.json" })
      );

      const config = loadAliasConfig("/repo/tsconfig.a.json", fs);
      assert.notStrictEqual(config, null);
      assert.strictEqual(config?.isIncomplete, true);
    });

    it("handles missing extends safely by marking config incomplete", () => {
      fs.addFile(
        "/repo/tsconfig.json",
        JSON.stringify({ extends: "./nonexistent.json" })
      );

      const config = loadAliasConfig("/repo/tsconfig.json", fs);
      assert.notStrictEqual(config, null);
      assert.strictEqual(config?.isIncomplete, true);
    });

    it("handles malformed JSONC safely without crashing", () => {
      fs.addFile("/repo/tsconfig.json", "{ malformed json content {{{");

      const config = loadAliasConfig("/repo/tsconfig.json", fs);
      assert.notStrictEqual(config, null);
      assert.strictEqual(config?.isIncomplete, true);
    });

    it("findConfigFile obeys deterministic tsconfig vs jsconfig rules", () => {
      fs.addFile("/project/tsconfig.json", "{}");
      fs.addFile("/project/jsconfig.json", "{}");
      fs.addFile("/project/sub/jsconfig.json", "{}");

      // .ts file always checks tsconfig.json, ignores jsconfig.json
      const tsMatch = findConfigFile("/project/sub/index.ts", fs);
      assert.strictEqual(tsMatch, "/project/tsconfig.json");

      // .js file finds nearest jsconfig.json in sub/
      const jsMatch = findConfigFile("/project/sub/index.js", fs);
      assert.strictEqual(jsMatch, "/project/sub/jsconfig.json");

      // .js file in folder with both prefers tsconfig.json
      const jsRootMatch = findConfigFile("/project/index.js", fs);
      assert.strictEqual(jsRootMatch, "/project/tsconfig.json");
    });
  });

  describe("2. Path Resolver Alias Casing Validation", () => {
    it("detects casing mismatch with wildcard alias and preserves alias prefix", () => {
      fs.addFile("/project/src/Components/Button.tsx", "export const Button = 1;");
      fs.addFile(
        "/project/tsconfig.json",
        JSON.stringify({
          compilerOptions: {
            paths: {
              "@/*": ["src/*"],
            },
          },
        })
      );

      const aliasConfig = loadAliasConfig("/project/tsconfig.json", fs);
      const result = resolveAndValidateImport(
        "/project/src/index.ts",
        "@/components/button",
        fs,
        cache,
        aliasConfig
      );

      assert.notStrictEqual(result, null);
      assert.strictEqual(result?.hasMismatch, true);
      assert.strictEqual(result?.isAmbiguous, false);
      assert.strictEqual(result?.originalSpecifier, "@/components/button");
      assert.strictEqual(result?.correctedSpecifier, "@/Components/Button");
      assert.strictEqual(result?.matchedPattern, "@/*");
    });

    it("exact match on disk produces null (no diagnostic)", () => {
      fs.addFile("/project/src/Components/Button.tsx", "export const Button = 1;");
      fs.addFile(
        "/project/tsconfig.json",
        JSON.stringify({
          compilerOptions: {
            paths: {
              "@/*": ["src/*"],
            },
          },
        })
      );

      const aliasConfig = loadAliasConfig("/project/tsconfig.json", fs);
      const result = resolveAndValidateImport(
        "/project/src/index.ts",
        "@/Components/Button",
        fs,
        cache,
        aliasConfig
      );

      assert.strictEqual(result, null);
    });

    it("non-existent file across all targets produces null (no false positives for missing files)", () => {
      fs.addFile(
        "/project/tsconfig.json",
        JSON.stringify({
          compilerOptions: {
            paths: {
              "@/*": ["src/*"],
            },
          },
        })
      );

      const aliasConfig = loadAliasConfig("/project/tsconfig.json", fs);
      const result = resolveAndValidateImport(
        "/project/src/index.ts",
        "@/nonexistent/path",
        fs,
        cache,
        aliasConfig
      );

      assert.strictEqual(result, null);
    });

    it("evaluates ordered fallback targets: Target 1 missing, Target 2 has mismatch", () => {
      fs.addFile("/project/common-ui/Button.tsx", "export const Button = 1;");
      fs.addDirectory("/project/custom-ui");
      fs.addFile(
        "/project/tsconfig.json",
        JSON.stringify({
          compilerOptions: {
            paths: {
              "@ui/*": ["custom-ui/*", "common-ui/*"],
            },
          },
        })
      );

      const aliasConfig = loadAliasConfig("/project/tsconfig.json", fs);
      const result = resolveAndValidateImport(
        "/project/src/index.ts",
        "@ui/button",
        fs,
        cache,
        aliasConfig
      );

      assert.notStrictEqual(result, null);
      assert.strictEqual(result?.hasMismatch, true);
      assert.strictEqual(result?.isAmbiguous, false);
      assert.strictEqual(result?.correctedSpecifier, "@ui/Button");
    });

    it("evaluates ordered fallback targets: Target 1 exact match, Target 2 case mismatch -> returns null", () => {
      fs.addFile("/project/custom-ui/button.tsx", "export const button = 1;");
      fs.addFile("/project/common-ui/Button.tsx", "export const Button = 2;");
      fs.addFile(
        "/project/tsconfig.json",
        JSON.stringify({
          compilerOptions: {
            paths: {
              "@ui/*": ["custom-ui/*", "common-ui/*"],
            },
          },
        })
      );

      const aliasConfig = loadAliasConfig("/project/tsconfig.json", fs);
      const result = resolveAndValidateImport(
        "/project/src/index.ts",
        "@ui/button",
        fs,
        cache,
        aliasConfig
      );

      // Target 1 exact match wins and resolves cleanly
      assert.strictEqual(result, null);
    });

    it("skips uncertain cases when alias config is marked incomplete", () => {
      fs.addFile("/project/src/Components/Button.tsx", "export const Button = 1;");
      fs.addFile(
        "/project/tsconfig.json",
        JSON.stringify({
          extends: "./missing-base.json",
          compilerOptions: {
            paths: {
              "@/*": ["src/*"],
            },
          },
        })
      );

      const aliasConfig = loadAliasConfig("/project/tsconfig.json", fs);
      assert.strictEqual(aliasConfig?.isIncomplete, true);

      const result = resolveAndValidateImport(
        "/project/src/index.ts",
        "@/components/button",
        fs,
        cache,
        aliasConfig
      );

      // Incomplete configuration suppresses diagnostics to prevent false alarms
      assert.strictEqual(result, null);
    });

    it("ignores node_modules package imports completely", () => {
      fs.addFile(
        "/project/tsconfig.json",
        JSON.stringify({
          compilerOptions: {
            paths: {
              "@/*": ["src/*"],
            },
          },
        })
      );

      const aliasConfig = loadAliasConfig("/project/tsconfig.json", fs);
      const r1 = resolveAndValidateImport("/project/src/index.ts", "react", fs, cache, aliasConfig);
      const r2 = resolveAndValidateImport("/project/src/index.ts", "@types/node", fs, cache, aliasConfig);
      const r3 = resolveAndValidateImport("/project/src/index.ts", "lodash/debounce", fs, cache, aliasConfig);

      assert.strictEqual(r1, null);
      assert.strictEqual(r2, null);
      assert.strictEqual(r3, null);
    });

    it("detects ambiguous matches on disk and suppresses automatic fix", () => {
      fs.addFile("/project/src/Components/Button.tsx", "export const Button = 1;");
      fs.addFile("/project/src/Components/button.tsx", "export const button = 2;");
      fs.addFile(
        "/project/tsconfig.json",
        JSON.stringify({
          compilerOptions: {
            paths: {
              "@/*": ["src/*"],
            },
          },
        })
      );

      const aliasConfig = loadAliasConfig("/project/tsconfig.json", fs);
      const result = resolveAndValidateImport(
        "/project/src/index.ts",
        "@/Components/button.tsx",
        fs,
        cache,
        aliasConfig
      );

      // Exact match exists on button.tsx -> null
      assert.strictEqual(result, null);

      // Ambiguous case match for BUTTON.tsx:
      const resultAmbiguous = resolveAndValidateImport(
        "/project/src/index.ts",
        "@/Components/BUTTON.tsx",
        fs,
        cache,
        aliasConfig
      );
      assert.notStrictEqual(resultAmbiguous, null);
      assert.strictEqual(resultAmbiguous?.isAmbiguous, true);
      assert.strictEqual(resultAmbiguous?.correctedSpecifier, undefined);
    });

    it("handles directory index import casing with aliases", () => {
      fs.addFile("/project/src/Utils/index.ts", "export const utils = 1;");
      fs.addFile(
        "/project/tsconfig.json",
        JSON.stringify({
          compilerOptions: {
            paths: {
              "~/*": ["src/*"],
            },
          },
        })
      );

      const aliasConfig = loadAliasConfig("/project/tsconfig.json", fs);
      const result = resolveAndValidateImport(
        "/project/src/index.ts",
        "~/utils",
        fs,
        cache,
        aliasConfig
      );

      assert.notStrictEqual(result, null);
      assert.strictEqual(result?.hasMismatch, true);
      assert.strictEqual(result?.correctedSpecifier, "~/Utils");
    });
  });

  describe("3. DiagnosticManager Integration & Scope Scanning", () => {
    it("scans file and populates diagnostic with alias mapping", () => {
      fs.addFile("/project/src/Components/Header.tsx", "export const Header = 1;");
      fs.addFile(
        "/project/tsconfig.json",
        JSON.stringify({
          compilerOptions: {
            paths: {
              "@/*": ["src/*"],
            },
          },
        })
      );

      const collection = vscode.languages.createDiagnosticCollection("test-alias-dm");
      const dm = new DiagnosticManager(collection, fs);

      const content = `import Header from "@/components/header";`;
      const mismatches = dm.scanFile("/project/src/index.ts", DEFAULT_CONFIG, "/project", content);

      assert.strictEqual(mismatches.length, 1);
      assert.strictEqual(mismatches[0].diagnostic.correctedSpecifier, "@/Components/Header");
      assert.strictEqual(mismatches[0].diagnostic.matchedPattern, "@/*");

      const diags = collection.get(vscode.Uri.file("/project/src/index.ts"));
      assert.strictEqual(diags?.length, 1);
    });

    it("workspace scan finds alias casing issues across multiple project files", () => {
      fs.addFile("/project/src/Components/Button.tsx", "export const Button = 1;");
      fs.addFile("/project/src/Components/Card.tsx", "export const Card = 2;");
      fs.addFile("/project/src/index.ts", `import Button from "@/components/button";`);
      fs.addFile("/project/src/home.ts", `import Card from "@/components/card";`);
      fs.addFile(
        "/project/tsconfig.json",
        JSON.stringify({
          compilerOptions: {
            paths: {
              "@/*": ["src/*"],
            },
          },
        })
      );

      const collection = vscode.languages.createDiagnosticCollection("test-alias-ws");
      const dm = new DiagnosticManager(collection, fs);

      const summary = dm.scanWorkspace(["/project"], DEFAULT_CONFIG);
      assert.strictEqual(summary.scannedFileCount, 4);
      assert.strictEqual(summary.mismatchCount, 2);

      assert.strictEqual(collection.get(vscode.Uri.file("/project/src/index.ts"))?.length, 1);
      assert.strictEqual(collection.get(vscode.Uri.file("/project/src/home.ts"))?.length, 1);
    });

    it("nested tsconfig in subfolder overrides ancestor tsconfig", () => {
      fs.addFile("/project/common/Header.tsx", "export const Header = 1;");
      fs.addFile("/project/packages/client/src/Header.tsx", "export const ClientHeader = 2;");
      fs.addFile(
        "/project/tsconfig.json",
        JSON.stringify({
          compilerOptions: {
            paths: {
              "@/*": ["common/*"],
            },
          },
        })
      );
      fs.addFile(
        "/project/packages/client/tsconfig.json",
        JSON.stringify({
          compilerOptions: {
            paths: {
              "@/*": ["src/*"],
            },
          },
        })
      );

      const collection = vscode.languages.createDiagnosticCollection("test-nested-config");
      const dm = new DiagnosticManager(collection, fs);

      const clientContent = `import Header from "@/header";`;
      const mismatches = dm.scanFile(
        "/project/packages/client/src/index.ts",
        DEFAULT_CONFIG,
        "/project",
        clientContent
      );

      assert.strictEqual(mismatches.length, 1);
      assert.strictEqual(mismatches[0].diagnostic.correctedSpecifier, "@/Header");
      assert.strictEqual(
        mismatches[0].diagnostic.actualDiskPath,
        "/project/packages/client/src/Header"
      );
    });

    it("invalidating alias config cache clears memoized config", () => {
      fs.addFile(
        "/project/tsconfig.json",
        JSON.stringify({
          compilerOptions: {
            paths: {
              "@/*": ["src/*"],
            },
          },
        })
      );

      const manager = new AliasConfigManager();
      const cfg1 = manager.getConfigForFile("/project/src/index.ts", fs);
      assert.notStrictEqual(cfg1, null);

      manager.invalidateConfig("/project/tsconfig.json");
      // Update config file
      fs.addFile(
        "/project/tsconfig.json",
        JSON.stringify({
          compilerOptions: {
            paths: {
              "@custom/*": ["custom/*"],
            },
          },
        })
      );

      const cfg2 = manager.getConfigForFile("/project/src/index.ts", fs);
      assert.strictEqual(cfg2?.mappings[0].pattern, "@custom/*");
    });
  });

  describe("4. Quick Fix & Bulk Remediation Integration", () => {
    it("provides Quick Fix action for alias mismatch preserving quotes", () => {
      fs.addFile("/project/src/Components/Button.tsx", "export const Button = 1;");
      fs.addFile(
        "/project/tsconfig.json",
        JSON.stringify({
          compilerOptions: {
            paths: {
              "@/*": ["src/*"],
            },
          },
        })
      );

      const collection = vscode.languages.createDiagnosticCollection("test-qf-alias");
      const dm = new DiagnosticManager(collection, fs);
      const provider = new ImportCaseCodeActionProvider(dm);

      const docContent = `import Button from "@/components/button";`;
      const doc = createMockDocument("/project/src/index.ts", docContent);
      const mismatches = dm.scanFile("/project/src/index.ts", DEFAULT_CONFIG, "/project", docContent);

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
        { diagnostics: [diag], triggerKind: 1 } as any,
        {} as any
      );

      const singleFix = actions.find((a) => a.title.includes("@/Components/Button"));
      assert.ok(singleFix, "Quick Fix with corrected alias must be present");

      const edit = (singleFix.edit as any).edits[0];
      assert.strictEqual(edit.newText, "@/Components/Button");
    });

    it("bulk fix repairs both relative and alias imports across file and workspace", async () => {
      fs.addFile("/project/src/Components/Button.tsx", "export const Button = 1;");
      fs.addFile("/project/src/Utils/Date.ts", "export const formatDate = 2;");
      fs.addFile(
        "/project/tsconfig.json",
        JSON.stringify({
          compilerOptions: {
            paths: {
              "@/*": ["src/*"],
            },
          },
        })
      );

      const collection = vscode.languages.createDiagnosticCollection("test-bulk-alias");
      const dm = new DiagnosticManager(collection, fs);

      const fileContent = [
        `import Button from "@/components/button";`,
        `import { formatDate } from "./Utils/date";`,
      ].join("\n");
      fs.addFile("/project/src/index.ts", fileContent);

      dm.scanWorkspace(["/project"], DEFAULT_CONFIG);

      const prep = dm.prepareFileBulkFixes(vscode.Uri.file("/project/src/index.ts"));
      assert.strictEqual(prep.valid, true);
      assert.strictEqual(prep.totalIssues, 2);

      await dm.applyFileFixes(vscode.Uri.file("/project/src/index.ts"), DEFAULT_CONFIG);

      const updated = fs.readFile("/project/src/index.ts");
      assert.strictEqual(
        updated,
        [
          `import Button from "@/Components/Button";`,
          `import { formatDate } from "./Utils/Date";`,
        ].join("\n")
      );
    });
  });
});
