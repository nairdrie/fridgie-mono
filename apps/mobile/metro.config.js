// Metro must be told about packages/shared explicitly: it lives outside the app
// directory, so by default Metro neither watches nor resolves it.
//
// Only the RUNTIME shared modules (quantity, rank) actually reach Metro —
// packages/shared/types.ts is re-exported with `export type *` and is fully
// erased before bundling.

const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '../..');

const config = getDefaultConfig(projectRoot);

config.watchFolders = [path.resolve(workspaceRoot, 'packages/shared')];

// Dependencies still resolve from this app only — packages/shared is source-only
// and pulls its one dependency (lexorank) from whichever app imports it.
config.resolver.nodeModulesPaths = [path.resolve(projectRoot, 'node_modules')];

module.exports = config;
