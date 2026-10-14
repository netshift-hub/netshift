'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const audit = fs.readFileSync(path.join(root, 'NETSHIFT_STATE_OWNERSHIP_AUDIT.md'), 'utf8');

function section(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0 && end > start, `section found: ${startMarker}`);
  return source.slice(start, end);
}

const fence = section(html, '// Stage 1 Chunk 9: retire unauthoritative inventory mutation paths', '</script>');

function testAuthenticatedHydrationDropsLocalOnlyInventory() {
  const loader = section(html, 'async function netshiftCoreLoadFiles(', 'function netshiftCoreTakenName(');
  assert.match(loader, /let nextLocalFiles = window\.NETSHIFT_USER \? \[\] :/,
    'authenticated hydration starts from an empty legacy file mirror');
  assert.match(loader, /const nextLocalFileFolders = window\.NETSHIFT_USER \? \{\} :/,
    'authenticated hydration discards the ambiguous filename-keyed location map');
  assert.match(loader, /let nextFolders = window\.NETSHIFT_USER \? \[\] :/,
    'authenticated hydration starts folders from canonical rows only');
  assert.match(loader, /let nextRecycle = window\.NETSHIFT_USER \? \[\] :/,
    'authenticated hydration starts the Recycle Bin from canonical rows only');
  assert.ok(loader.includes('state.owned = [...new Set(installedIds)];'),
    'software ownership mirror is rebuilt solely from server-installed rows');
  assert.ok(loader.includes('state.archiveSoftware = archivedIds.map'),
    'Archive software mirror is rebuilt solely from canonical rows');
  assert.ok(!loader.includes('legacyOwned') && !loader.includes('legacyArchive'),
    'authenticated hydration no longer carries unmatched browser-only ownership');
}

function testAuthenticatedViewsIgnoreLocalOnlyRows() {
  const shadow = section(html, 'function netshiftCoreIsShadowedLegacyFile(', 'function renderLocalFileRowV16(');
  assert.match(shadow, /if \(window\.NETSHIFT_USER\) return true;/,
    'every non-canonical file mirror is hidden for an authenticated account');
  const softwareView = section(html, 'function netshiftCoreSoftwareRowsForView(', 'function netshiftCoreRenderSoftwareRow(');
  assert.match(softwareView, /if \(window\.NETSHIFT_USER\) return canonical;/,
    'authenticated desktop/archive software views expose canonical rows only');
  const explorer = section(html, "renderExplorerContent = function renderExplorerContent()", "netshiftRenderUserFolders = function netshiftRenderUserFolders()");
  assert.match(explorer, /filter\(entry => !window\.NETSHIFT_USER \|\| !!entry\?\._coreFileId\)/,
    'authenticated Recycle Bin view hides rows without canonical record IDs');
  assert.match(explorer, /if \(!window\.NETSHIFT_USER\)\s*\{[\s\S]*?Temporary local folder/,
    'temporary local folders are only displayed in offline mode');
  const desktopFolders = section(html, 'netshiftRenderUserFolders = function netshiftRenderUserFolders()', 'var netshiftCorePreviousDropOnFolderV16');
  assert.match(desktopFolders, /filter\(folder => !window\.NETSHIFT_USER \|\| !!folder\?\._coreFolderId\)/,
    'authenticated desktop renders only server-owned folders');
}

function testInventoryWritePathsAreFenced() {
  for (const name of [
    'installSoftwareLocally', 'completeNetworkDownloadV11', 'queueNetworkDownloadV11',
    'downloadServerFile', 'downloadSoftware', 'buySoftware', 'openLocalFileV11',
    'openLocalFileByNameV11', 'contextAction', 'dropOnFolderV16',
    'restoreRecycleV16', 'permanentlyDeleteRecycleV16', 'emptyRecycleBinV16'
  ]) {
    assert.ok(fence.includes(`${name} = function`) || fence.includes(`${name} = async function`), `${name} has a final Chunk 9 wrapper`);
  }
  assert.match(fence, /if \(window\.NETSHIFT_USER\) return netshiftStage1BlockLegacyInventoryWrite\('Software installation/,
    'local software install helper cannot create authenticated ownership');
  assert.match(fence, /if \(window\.NETSHIFT_USER\) return netshiftStage1BlockLegacyInventoryWrite\('Legacy website downloads/,
    'queued legacy downloads are retired for signed-in users');
  assert.match(fence, /Software purchases are disabled until the server-side shop and ledger are implemented/,
    'unbacked software purchase cannot mutate browser balance or inventory');
  assert.match(fence, /Only server-backed files and software can be moved/,
    'legacy drag/drop inventory moves fail closed when signed in');
  assert.match(fence, /state\.recycleBin\[Number\(index\)\][\s\S]*?entry\?\._coreFileId/,
    'Recycle Bin restore/permanent-delete controls require a canonical record ID');
  assert.match(fence, /\/api\/core\/files\/['"] \+ encodeURIComponent\(entry\._coreFileId\) \+ '\/permanent/,
    'emptying Recycle Bin uses owner-scoped canonical API calls');
  assert.ok(fence.includes("if (!window.NETSHIFT_USER) return netshiftStage1PreviousEmptyRecycleBin(...args);"),
    'offline legacy prototype remains available when no account is signed in');
}

function testSoftwareExecutionUsesCanonicalDesktopRows() {
  assert.match(fence, /NETSHIFT_CORE_SOFTWARE\.some\(item => item\.softwareId === id && item\._coreLocation === 'desktop'\)/,
    'signed-in accounts may only execute software present in canonical Desktop inventory');
  assert.match(fence, /NETSHIFT_CORE_SOFTWARE\.filter\(item => item\._coreLocation === 'desktop'.*software\[item\.softwareId\]\?\.family === family\)/,
    'ownedFamily resolves from canonical installed software only while signed in');
}

function testCheckCommandAndAuditAreUpdated() {
  assert.ok(pkg.scripts.check.includes('node scripts/check-stage1-legacy-inventory-fence.js'),
    'legacy inventory fence regression test is part of npm run check');
  assert.ok(audit.includes('Chunk 9'), 'ownership audit records Chunk 9 status');
  assert.ok(audit.includes('legacy inventory writers fenced locally') && audit.includes('no longer retained as inventory authority'), 'audit documents that legacy-only inventory is retired for authenticated users');
}

testAuthenticatedHydrationDropsLocalOnlyInventory();
testAuthenticatedViewsIgnoreLocalOnlyRows();
testInventoryWritePathsAreFenced();
testSoftwareExecutionUsesCanonicalDesktopRows();
testCheckCommandAndAuditAreUpdated();
console.log('Stage 1 legacy inventory fence checks OK (authenticated hydration, canonical-only views, guarded downloads/software/recycle paths).');
