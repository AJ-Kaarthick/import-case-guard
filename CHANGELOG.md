# Change Log

All notable changes to the "import-case-guard" extension will be documented in this file.

## [1.0.0] - 2026-10-08

### Added
- Initial release of Import Case Guard.
- Automatic detection of relative import-path casing mismatches on both case-sensitive and case-insensitive filesystems.
- Automatic background workspace scan on activation and automatic rescan on document open, edit (debounced), save, and active editor switch.
- Native VS Code diagnostics with Warning severity.
- Contextual Hover provider with requested path, actual path, and cross-platform explanation.
- Contextual `Ctrl+.` / `Cmd+.` Quick Fix remediation:
  - Fix individual import (`Correct import casing to '...'`).
  - Fix all casing issues in current file with dynamic count.
  - Fix all casing issues in workspace with dynamic total and file counts.
- Bulk fix safety and validation:
  - Pre-validation of edit coordinates against editor buffer before modifications.
  - Coordinate shifts prevented by applying edits in descending line/character order.
  - Safe WorkspaceEdit coordination (if prevalidation fails or user cancels, no edits are applied).
  - Native confirmation dialogs with cancellation support.
  - Full single-step undo support via standard VS Code WorkspaceEdit.
- Syntax and resolver support:
  - Static `import`, side-effect `import`, type-only `import`, and re-exports (`export ... from`).
  - CommonJS `require()` and dynamic `import()`.
  - Static non-interpolated template literals in `require()` and `import()`.
  - Dotted directory and file specifiers (e.g., `./.storybook/main`, `../.eslintrc`).
  - Extensionless file resolution (`.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, `.cjs`, `.json`).
  - Directory index file resolution (`index.ts`, `index.js`, etc.).
  - Multi-segment casing mismatch resolution (e.g., `./components/button` -> `./Components/Button`).
  - Symlink inspection verifying link entry name casing without `realpath` redirection.
  - Robust regex literal detection in tokenizer preventing false string/comment parsing.
  - Ambiguity handling suppressing Quick Fix when multiple candidates exist on disk.
- Performance and multi-root architecture:
  - Multi-root workspace support with document-relative import resolution.
  - Dependency-based directory invalidation via file watchers without blanket workspace rescans.
  - Rapid watcher burst event debouncing.
  - Large-file guard skipping files >1 MB safely.
  - Configurable exclusions (`importCaseGuard.exclude`), debounce delay (`importCaseGuard.debounceMs`), and toggle (`importCaseGuard.enable`).
- Command Palette fallback commands:
  - `Import Case Guard: Scan Current File` (`import-case-guard.scanCurrentFile`).
  - `Import Case Guard: Scan Workspace` (`import-case-guard.scanWorkspace`).
  - `Import Case Guard: Fix All in Current File` (`import-case-guard.fixAllInFile`).
  - `Import Case Guard: Fix All in Workspace` (`import-case-guard.fixAllInWorkspace`).
