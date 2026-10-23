import * as fs from 'fs';
import * as path from 'path';

const targetDir = path.join(process.cwd(), 'node_modules', 'vscode');
const srcDir = path.join(process.cwd(), 'test', 'mocks', 'vscode');

if (!fs.existsSync(path.join(targetDir, 'index.js'))) {
  fs.mkdirSync(targetDir, { recursive: true });
  fs.copyFileSync(path.join(srcDir, 'package.json'), path.join(targetDir, 'package.json'));
  fs.copyFileSync(path.join(srcDir, 'index.js'), path.join(targetDir, 'index.js'));
}
