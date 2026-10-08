import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { scanImports, isLocalRelativeImport } from '../src/scanner/importScanner';

describe('Scanner & Tokenizer Tests', () => {
  it('1. should detect standard static import', () => {
    const code = `import Button from "./components/button";`;
    const result = scanImports(code);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].rawSpecifier, './components/button');
    assert.strictEqual(result[0].quote, '"');
    assert.strictEqual(result[0].kind, 'static-import');
  });

  it('2. should detect side-effect import', () => {
    const code = `import "./styles/main.css";`;
    const result = scanImports(code);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].rawSpecifier, './styles/main.css');
    assert.strictEqual(result[0].kind, 'side-effect');
  });

  it('3. should detect type import', () => {
    const code = `import type { User } from '../models/user';`;
    const result = scanImports(code);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].rawSpecifier, '../models/user');
    assert.strictEqual(result[0].quote, "'");
    assert.strictEqual(result[0].kind, 'type-import');
  });

  it('4. should detect re-exports (export from and export * from)', () => {
    const code = `
      export { Button } from "./components/button";
      export * from "../utils/helpers";
    `;
    const result = scanImports(code);
    assert.strictEqual(result.length, 2);
    assert.strictEqual(result[0].rawSpecifier, './components/button');
    assert.strictEqual(result[0].kind, 'export-from');
    assert.strictEqual(result[1].rawSpecifier, '../utils/helpers');
    assert.strictEqual(result[1].kind, 'export-from');
  });

  it('5. should detect CommonJS require()', () => {
    const code = `const helper = require("./utils/helper");`;
    const result = scanImports(code);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].rawSpecifier, './utils/helper');
    assert.strictEqual(result[0].kind, 'require');
  });

  it('6. should detect dynamic import()', () => {
    const code = `const mod = await import("../components/modal");`;
    const result = scanImports(code);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].rawSpecifier, '../components/modal');
    assert.strictEqual(result[0].kind, 'dynamic-import');
  });

  it('7. should support static template literals without interpolation in require/import', () => {
    const code = `
      const a = require(\`./components/button\`);
      const b = import(\`../utils/math\`);
    `;
    const result = scanImports(code);
    assert.strictEqual(result.length, 2);
    assert.strictEqual(result[0].rawSpecifier, './components/button');
    assert.strictEqual(result[0].quote, '`');
    assert.strictEqual(result[1].rawSpecifier, '../utils/math');
    assert.strictEqual(result[1].quote, '`');
  });

  it('8. should NOT treat template literals with interpolation as static import specifiers', () => {
    const code = `
      const name = "button";
      const a = require(\`./components/\${name}\`);
      const b = import(\`../utils/\${category}/math\`);
    `;
    const result = scanImports(code);
    assert.strictEqual(result.length, 0);
  });

  it('9. should ignore package imports', () => {
    const code = `
      import React from "react";
      import { debounce } from "lodash";
      import * as path from "node:path";
      const fs = require("fs");
      const sub = await import("@scope/package");
    `;
    const result = scanImports(code);
    assert.strictEqual(result.length, 0);
  });

  it('10. should ignore non-relative alias imports', () => {
    const code = `
      import Button from "@/components/Button";
      import { util } from "~/utils";
      import api from "@api/client";
    `;
    const result = scanImports(code);
    assert.strictEqual(result.length, 0);
  });

  it('11. should ignore imports inside single-line comments', () => {
    const code = `
      // import Button from "./components/button";
      // const x = require("./utils");
      const a = 1;
    `;
    const result = scanImports(code);
    assert.strictEqual(result.length, 0);
  });

  it('12. should ignore imports inside multi-line comments', () => {
    const code = `
      /*
        import Button from "./components/button";
        require("../utils");
      */
      const a = 1;
    `;
    const result = scanImports(code);
    assert.strictEqual(result.length, 0);
  });

  it('13. should ignore import strings inside normal variables and template strings', () => {
    const code = `
      const log = "import Button from './components/button';";
      const template = \`import Button from './components/button';\`;
      const query = "require('./something')";
    `;
    const result = scanImports(code);
    assert.strictEqual(result.length, 0);
  });

  it('14. should ignore dynamic expressions with variables in require and import', () => {
    const code = `
      const mod = require(someVar);
      const res = import(getDynamicPath());
      const concat = require("./" + dynamicName);
    `;
    const result = scanImports(code);
    assert.strictEqual(result.length, 0);
  });

  it('15. should handle malformed or incomplete statements gracefully without throwing', () => {
    const code = `
      import
      import {
      require(
      import (
      export from
    `;
    assert.doesNotThrow(() => {
      const result = scanImports(code);
      assert.strictEqual(result.length, 0);
    });
  });

  it('16. isLocalRelativeImport helper validation', () => {
    assert.strictEqual(isLocalRelativeImport('./foo'), true);
    assert.strictEqual(isLocalRelativeImport('../foo'), true);
    assert.strictEqual(isLocalRelativeImport('../../foo'), true);
    assert.strictEqual(isLocalRelativeImport('.\\foo'), true);
    assert.strictEqual(isLocalRelativeImport('..\\foo'), true);
    assert.strictEqual(isLocalRelativeImport('.'), true);
    assert.strictEqual(isLocalRelativeImport('..'), true);

    assert.strictEqual(isLocalRelativeImport('react'), false);
    assert.strictEqual(isLocalRelativeImport('@/components'), false);
    assert.strictEqual(isLocalRelativeImport('~/utils'), false);
    assert.strictEqual(isLocalRelativeImport('/absolute/path'), false);
    assert.strictEqual(isLocalRelativeImport(''), false);
  });

  it('17. should correctly recognize regex literals before imports without breaking tokenization', () => {
    const code = `
      const cleaned = path.replace(/\\/*$/, "");
      const isUrl = /https?:\\/\\//.test(cleaned);
      const hasQuote = /'/.test(cleaned);
      import Button from "./components/button";
    `;
    const result = scanImports(code);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].rawSpecifier, './components/button');
  });

  it('18. should handle multiple regex patterns with brackets and escapes before import', () => {
    const code = `
      const r1 = /[/]/;
      const r2 = /\\/\\//;
      const r3 = /abc/gi;
      const r4 = /'|"/;
      import { modal } from "../components/modal";
    `;
    const result = scanImports(code);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].rawSpecifier, '../components/modal');
  });

  it('19. should preserve division operator and scan following import', () => {
    const code = `
      const x = a / b;
      const y = (10 + 20) / 2;
      const z = arr[0] / 5;
      import utils from "./utils/math";
    `;
    const result = scanImports(code);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].rawSpecifier, './utils/math');
  });

  it('20. should correctly support imports where a named specifier is named "from"', () => {
    const code = `
      import { from } from "./rx";
      import { from as observableFrom, of } from "./stream";
    `;
    const result = scanImports(code);
    assert.strictEqual(result.length, 2);
    assert.strictEqual(result[0].rawSpecifier, './rx');
    assert.strictEqual(result[1].rawSpecifier, './stream');
  });

  it('21. should correctly support exports where a named specifier is named "from"', () => {
    const code = `
      export { from } from "./observable";
      export { from, to } from "./conversion";
    `;
    const result = scanImports(code);
    assert.strictEqual(result.length, 2);
    assert.strictEqual(result[0].rawSpecifier, './observable');
    assert.strictEqual(result[1].rawSpecifier, './conversion');
  });

  it('22. should guard against excessively large files (>1MB)', () => {
    const bigString = 'import Button from "./components/button";\n' + ' '.repeat(1024 * 1024 + 10);
    const result = scanImports(bigString);
    assert.strictEqual(result.length, 0);
  });
});
