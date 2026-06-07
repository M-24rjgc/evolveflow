import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const repoRoot = path.resolve(import.meta.dirname, '..');
const resourcesDir = path.join(repoRoot, 'apps', 'desktop-tauri', 'src-tauri', 'resources');

function copyRequired(src, dest) {
  if (!fs.existsSync(src)) {
    throw new Error(`Required resource not found: ${src}`);
  }
  fs.cpSync(src, dest, { recursive: true, force: true, dereference: true });
}

function copyPackage(packageName, sourceDir) {
  const destDir = path.join(resourcesDir, 'node_modules', '@evolveflow', packageName);
  copyRequired(path.join(sourceDir, 'package.json'), path.join(destDir, 'package.json'));
  copyRequired(path.join(sourceDir, 'dist'), path.join(destDir, 'dist'));
}

fs.rmSync(resourcesDir, { recursive: true, force: true });
fs.mkdirSync(resourcesDir, { recursive: true });

copyRequired(process.execPath, path.join(resourcesDir, 'node', process.platform === 'win32' ? 'node.exe' : 'node'));
copyRequired(path.join(repoRoot, 'runtime', 'dist'), path.join(resourcesDir, 'runtime', 'dist'));

copyPackage('storage', path.join(repoRoot, 'packages', 'evolveflow-storage'));
copyPackage('domain', path.join(repoRoot, 'packages', 'evolveflow-domain'));
copyPackage('capabilities', path.join(repoRoot, 'packages', 'evolveflow-capabilities'));

for (const dependency of ['better-sqlite3', 'bindings', 'file-uri-to-path', 'uuid']) {
  copyRequired(
    path.join(repoRoot, 'node_modules', dependency),
    path.join(resourcesDir, 'node_modules', dependency),
  );
}

console.log(`[prepare-tauri-resources] Staged runtime resources in ${resourcesDir}`);
