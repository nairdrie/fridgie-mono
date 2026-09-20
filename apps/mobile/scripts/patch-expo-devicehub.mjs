#!/usr/bin/env node
/**
 * Xcode 27 removed Simulator.app and replaced it with DeviceHub.app
 * (bundle id `com.apple.dt.Devices`). @expo/cli in SDK 53 hardcodes the old
 * app, so `expo start` -> `i` / `expo run:ios` bail out with
 * "Can't determine id of Simulator app".
 *
 * This mirrors the upstream fix (expo/expo#50250, landed in SDK 54) against the
 * built CLI in node_modules. Idempotent - re-run it after every install.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let cliRoot;
try {
  cliRoot = path.dirname(createRequire(path.join(root, 'package.json')).resolve('@expo/cli/package.json'));
} catch {
  console.error('@expo/cli not installed yet - skipping DeviceHub patch.');
  process.exit(0);
}
const base = path.join(cliRoot, 'build/src/start');

const edits = [
  {
    file: path.join(base, 'doctor/apple/SimulatorAppPrerequisite.js'),
    replacements: [
      [
        `        return (await (0, _osascript().execAsync)('id of app "Simulator"')).trim();`,
        `        return (await (0, _osascript().execAsync)('id of app "Simulator"')).trim();\n    } catch  {\n    // Xcode 27+: Simulator.app is gone, DeviceHub.app replaces it.\n    }\n    try {\n        return (await (0, _osascript().execAsync)('id of app "DeviceHub"')).trim();`,
      ],
      [
        `if (result !== 'com.apple.iphonesimulator' && result !== 'com.apple.CoreSimulator.SimulatorTrampoline') {`,
        `if (result !== 'com.apple.iphonesimulator' && result !== 'com.apple.CoreSimulator.SimulatorTrampoline' && result !== 'com.apple.dt.Devices') {`,
      ],
    ],
  },
  {
    file: path.join(base, 'platforms/ios/ensureSimulatorAppRunning.js'),
    replacements: [
      [
        `'tell app "System Events" to count processes whose name is "Simulator"'`,
        `'tell app "System Events" to count processes whose name is "Simulator" or name is "DeviceHub"'`,
      ],
      [
        `    const args = [\n        '-a',\n        'Simulator'\n    ];\n    if (device.udid) {`,
        `    const hasSimulatorApp = await _osascript().execAsync('id of app "Simulator"').then(()=>true, ()=>false);\n    const args = [\n        '-a',\n        hasSimulatorApp ? 'Simulator' : 'DeviceHub'\n    ];\n    if (hasSimulatorApp && device.udid) {`,
      ],
    ],
  },
  {
    file: path.join(base, 'platforms/ios/AppleDeviceManager.js'),
    replacements: [
      [
        'await _osascript().execAsync(`tell application "Simulator" to activate`);',
        'await _osascript().execAsync(`if application "Simulator" is running then tell application "Simulator" to activate else if application "DeviceHub" is running then tell application "DeviceHub" to activate`);',
      ],
    ],
  },
];

let changed = 0;
for (const { file, replacements } of edits) {
  if (!fs.existsSync(file)) {
    console.error(`skip (missing): ${path.relative(root, file)}`);
    continue;
  }
  let src = fs.readFileSync(file, 'utf8');
  const before = src;
  for (const [from, to] of replacements) {
    if (src.includes(to)) continue; // already patched
    if (!src.includes(from)) {
      console.error(`skip (pattern not found): ${path.relative(root, file)}`);
      continue;
    }
    src = src.replace(from, to);
  }
  if (src !== before) {
    fs.writeFileSync(file, src);
    changed++;
    console.log(`patched: ${path.relative(root, file)}`);
  } else {
    console.log(`already patched: ${path.relative(root, file)}`);
  }
}
console.log(changed ? 'DeviceHub patch applied.' : 'Nothing to do.');
