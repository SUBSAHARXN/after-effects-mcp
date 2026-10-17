import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const isMac = process.platform === 'darwin';
const isWindows = process.platform === 'win32';

const detectedAEPaths = [];
if (isMac) {
  const appsDir = '/Applications';
  if (fs.existsSync(appsDir)) {
    for (const name of fs.readdirSync(appsDir)) {
      if (/Adobe After Effects/i.test(name)) {
        detectedAEPaths.push(path.join(appsDir, name));
      }
    }
  }
} else {
  const progFiles = process.env['ProgramFiles'] || 'C:\\Program Files';
  const adobeDir = path.join(progFiles, 'Adobe');
  if (fs.existsSync(adobeDir)) {
    for (const name of fs.readdirSync(adobeDir)) {
      if (/Adobe After Effects/i.test(name)) {
        detectedAEPaths.push(path.join(adobeDir, name));
      }
    }
  }
}

const scriptsDir = path.join(__dirname, 'build', 'scripts');
const sourceFiles = ['mcp-bridge-auto.jsx', 'lottieCompiler.jsx'];

for (const sf of sourceFiles) {
  const p = path.join(scriptsDir, sf);
  if (!fs.existsSync(p)) {
    console.error(`Error: Source script not found at ${p}`);
    console.error('Please run "npm run build" first to generate the scripts.');
    process.exit(1);
  }
}

function collectDestinationFolders() {
  const folders = [];

  // 1. Prioritize user AppData directories (requires zero elevation)
  const appData = process.env.APPDATA;
  if (appData) {
    const aeRoot = path.join(appData, 'Adobe', 'After Effects');
    if (fs.existsSync(aeRoot)) {
      for (const versionDir of fs.readdirSync(aeRoot)) {
        // Only target genuine AE version directories (e.g. 24.0, 25.0)
        if (/^\d+(\.\d+)*$/.test(versionDir)) {
          const versionRoot = path.join(aeRoot, versionDir);
          if (fs.statSync(versionRoot).isDirectory()) {
            folders.push(path.join(versionRoot, 'Scripts'));
            folders.push(path.join(versionRoot, 'Scripts', 'ScriptUI Panels'));
          }
        }
      }
    }
  }

  // 2. Program Files / System Application paths
  for (const aePath of detectedAEPaths) {
    if (isMac) {
      folders.push(path.join(aePath, 'Scripts', 'ScriptUI Panels'));
    } else {
      folders.push(path.join(aePath, 'Support Files', 'Scripts', 'ScriptUI Panels'));
    }
  }

  const unique = [];
  const seen = new Set();
  for (const f of folders) {
    if (!seen.has(f)) {
      unique.push(f);
      seen.add(f);
    }
  }
  return unique;
}

function copyDirect(sourcePath, destinationPath) {
  const destinationFolder = path.dirname(destinationPath);
  if (!fs.existsSync(destinationFolder)) {
    fs.mkdirSync(destinationFolder, { recursive: true });
  }
  fs.copyFileSync(sourcePath, destinationPath);
}

function copyElevatedWindows(destFolder, srcFiles) {
  const copyCommands = srcFiles.map(file => {
    const src = path.join(scriptsDir, file).replace(/'/g, "''");
    const dst = path.join(destFolder, file).replace(/'/g, "''");
    return `Copy-Item -LiteralPath '${src}' -Destination '${dst}' -Force;`;
  }).join(' ');

  const scriptContent = `
    $dir = '${destFolder.replace(/'/g, "''")}';
    if (-not (Test-Path -LiteralPath $dir)) {
      [void](New-Item -ItemType Directory -Path $dir -Force);
    }
    ${copyCommands}
  `;

  const encoded = Buffer.from(scriptContent, 'utf16le').toString('base64');
  execSync(`powershell -NoProfile -Command "Start-Process PowerShell -Verb RunAs -Wait -ArgumentList '-EncodedCommand ${encoded}'"`, { stdio: 'inherit' });
}

try {
  const destinations = collectDestinationFolders();
  if (destinations.length === 0) {
    throw new Error('No destination paths found for bridge installation.');
  }

  const installed = [];
  const failed = [];

  for (const destFolder of destinations) {
    try {
      console.log(`Installing bridge scripts to ${destFolder}...`);

      let needsElevated = false;
      for (const file of sourceFiles) {
        const src = path.join(scriptsDir, file);
        const dst = path.join(destFolder, file);
        try {
          copyDirect(src, dst);
        } catch (err) {
          if (isWindows && destFolder.toLowerCase().includes('program files')) {
            needsElevated = true;
            break;
          } else if (isMac) {
            execSync(`sudo cp "${src}" "${dst}"`, { stdio: 'inherit' });
          } else {
            throw err;
          }
        }
      }

      if (needsElevated) {
        try {
          copyElevatedWindows(destFolder, sourceFiles);
        } catch (elevatedErr) {
          console.warn(`Admin elevation skipped or failed for ${destFolder}: ${elevatedErr.message}`);
          failed.push({ destFolder, error: elevatedErr.message });
          continue;
        }
      }

      installed.push(destFolder);
    } catch (copyError) {
      failed.push({ destFolder, error: copyError.message });
    }
  }

  if (installed.length === 0) {
    throw new Error(`Failed to install to all destinations. First error: ${failed[0].error}`);
  }

  console.log('\nBridge scripts successfully installed to:');
  for (const target of installed) {
    console.log(`- ${target}`);
  }

  if (failed.length > 0) {
    console.warn('\nSome destinations failed:');
    for (const failure of failed) {
      console.warn(`- ${failure.destFolder}: ${failure.error}`);
    }
    console.warn('This is usually fine if at least one active After Effects Scripts path succeeded.');
  }

  console.log('\nBridge scripts installed successfully!');
  console.log('\nImportant next steps:');
  console.log('1. Open After Effects');
  if (isMac) {
    console.log('2. Go to After Effects > Settings > Scripting & Expressions');
  } else {
    console.log('2. Go to Edit > Preferences > Scripting & Expressions');
  }
  console.log('3. Enable "Allow Scripts to Write Files and Access Network"');
  console.log('4. Restart After Effects');
  console.log('5. Open the bridge panel: Window > mcp-bridge-auto.jsx');
} catch (error) {
  console.error(`\nError during installation: ${error.message}`);
  process.exit(1);
}
