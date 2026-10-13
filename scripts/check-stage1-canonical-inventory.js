'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

function section(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0 && end > start, `section found: ${startMarker}`);
  return source.slice(start, end);
}

function htmlEscape(value) {
  return String(value).replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[ch]);
}

const helperCode = section(html, 'function netshiftCoreFolderLocation(', 'function netshiftValidateCoreFileRows(');
const registry = {
  crc1: { family: 'crc', level: 1, name: 'Password Cracker L1', ext: '.exe' },
  wwl1: { family: 'wwl', level: 1, name: 'Waterwall L1', ext: '.exe' },
  warez1: { family: 'warez', level: 1, name: 'Warez Virus L1', ext: '.vshare' },
  av1: { family: 'av', level: 1, name: 'Anti-Malware', ext: '.exe' }
};
const state = { localFileFolders: {}, localFiles: [] };
const helpers = new Function('software', 'state', `${helperCode}\nreturn {
  netshiftCoreFolderLocation, netshiftCoreParentPathForLocation,
  netshiftCoreNormaliseSoftwareFamily, netshiftCoreResolveSoftwareId,
  netshiftCoreMapFile, netshiftCoreMapSoftware, netshiftCoreLocalFileLocation,
  netshiftCoreRecordParentPath, netshiftCoreUpsertLocalFile, netshiftCoreInlineArg
};`)(registry, state);

function testCanonicalMappingHelpers() {
  assert.equal(helpers.netshiftCoreFolderLocation('/'), 'desktop');
  assert.equal(helpers.netshiftCoreFolderLocation('/desktop'), 'desktop');
  assert.equal(helpers.netshiftCoreFolderLocation('/downloads'), 'downloads');
  assert.equal(helpers.netshiftCoreFolderLocation('/archive'), 'archive');
  assert.equal(helpers.netshiftCoreFolderLocation('/Reports/2026'), 'custom:/Reports/2026');
  assert.equal(helpers.netshiftCoreParentPathForLocation('desktop'), '/');
  assert.equal(helpers.netshiftCoreParentPathForLocation('downloads'), '/downloads');
  assert.equal(helpers.netshiftCoreParentPathForLocation('custom:/Reports/2026'), '/Reports/2026');

  assert.equal(helpers.netshiftCoreNormaliseSoftwareFamily('Waterwall'), 'wwl');
  assert.equal(helpers.netshiftCoreNormaliseSoftwareFamily('password_cracker'), 'crc');
  assert.equal(helpers.netshiftCoreResolveSoftwareId('waterwall', 1), 'wwl1');
  assert.equal(helpers.netshiftCoreResolveSoftwareId('unlisted-family', 1), null,
    'unknown software must remain unmapped rather than having its family guessed');

  const file = helpers.netshiftCoreMapFile({
    id: 'uuid-file-a', parent_path: '/Reports', name: 'notes.txt', item_type: 'file',
    content: 'hello', mime_type: 'text/plain'
  });
  assert.equal(file._coreFileId, 'uuid-file-a');
  assert.equal(file._coreParentPath, '/Reports');
  assert.equal(file._coreItemType, 'file');
  assert.equal(helpers.netshiftCoreLocalFileLocation(file), 'custom:/Reports',
    'canonical location derives from its parent path, not a filename-keyed map');

  const software = helpers.netshiftCoreMapSoftware({
    id: 'uuid-software-a', parent_path: '/downloads', name: 'Waterwall L1.exe',
    item_type: 'software', software_family: 'waterwall', software_level: 1
  });
  assert.equal(software._coreFileId, 'uuid-software-a');
  assert.equal(software.softwareId, 'wwl1');
  assert.equal(software._coreLocation, 'downloads');

  const unknown = helpers.netshiftCoreMapSoftware({
    id: 'uuid-unknown', parent_path: '/archive', name: 'mystery.bin',
    item_type: 'software', software_family: 'new-family', software_level: 3
  });
  assert.equal(unknown.softwareId, null);
  assert.equal(unknown.name, 'mystery.bin');
  assert.equal(unknown._coreFileId, 'uuid-unknown');

  helpers.netshiftCoreUpsertLocalFile({
    id: 'uuid-file-a', parent_path: '/Reports', name: 'renamed.txt', item_type: 'file', content: 'updated'
  });
  helpers.netshiftCoreUpsertLocalFile({
    id: 'uuid-file-b', parent_path: '/', name: 'renamed.txt', item_type: 'file', content: 'separate same-name record'
  });
  assert.equal(state.localFiles.length, 2, 'canonical files with the same name remain distinct by server ID');
  assert.deepEqual(state.localFileFolders, {}, 'canonical files do not write into the legacy filename-keyed location map');
  helpers.netshiftCoreUpsertLocalFile({
    id: 'uuid-software-b', parent_path: '/', name: 'Warez Virus L1.vshare', item_type: 'software',
    software_family: 'warez', software_level: 1
  });
  helpers.netshiftCoreUpsertLocalFile({
    id: 'uuid-folder-b', parent_path: '/', name: 'ArchiveFolder', item_type: 'folder'
  });
  assert.equal(state.localFiles.length, 2, 'software and folder rows never enter the text-file mirror');
}

function testInventoryHydrationKeepsTypesAndCanonicalCollectionsSeparate() {
  const loader = section(html, 'async function netshiftCoreLoadFiles(', 'function netshiftCoreTakenName(');
  assert.ok(loader.includes('const nextSoftware = [];'), 'loader creates a separate software view model');
  assert.ok(loader.includes('const nextCoreFolders = [];'), 'loader creates a separate folder view model');
  assert.match(loader, /else if \(row\.item_type === 'software'\)\s*\{\s*nextSoftware\.push\(netshiftCoreMapSoftware\(row\)\);/,
    'software rows are mapped to the software collection');
  assert.match(loader, /if \(row\.item_type === 'folder'\)\s*\{[\s\S]*?nextCoreFolders\.push\(folder\)/,
    'folder rows are mapped to the folder collection');
  assert.match(loader, /else\s*\{\s*const mapped = netshiftCoreMapFile\(row\);\s*nextLocalFiles\.push\(mapped\);/,
    'only file rows enter the text-file mirror');
  assert.ok(loader.includes('type: row.item_type'), 'Recycle Bin preserves canonical item type');
  assert.ok(loader.includes('_coreFileId: row.id'), 'Recycle Bin retains canonical record ID');
  assert.ok(loader.includes('state.owned = [...new Set([...legacyOwned, ...installedIds])];'),
    'installed-software compatibility mirror derives canonical portion from server rows');
  assert.ok(loader.includes('state.archiveSoftware = [...legacyArchive, ...archivedIds.map'),
    'Archive compatibility mirror derives canonical portion from server rows');
  assert.ok(loader.includes('state.localFiles = previous.localFiles') && loader.includes('state.owned = previous.owned'),
    'failed refresh restores all mutated mirrors');
  assert.ok(loader.includes('!netshiftCoreIsShadowedLegacyFile(file, activeRows)'),
    'successful hydration removes the legacy demo file and avoids duplicating a canonical file view');
  assert.ok(!loader.includes('nextLocalFileFolders[mapped.name] ='),
    'canonical rows do not populate the filename-keyed legacy location map');
  const saveNotepad = section(html, 'async function netshiftCoreSaveNotepad(', 'async function netshiftCoreReloadNotepad(');
  assert.ok(!saveNotepad.includes('state.localFileFolders'),
    'canonical Notepad rename/save does not corrupt filename-keyed legacy location state');

  const takenName = section(html, 'function netshiftCoreTakenName(', 'function netshiftCoreUniqueUntitledName(');
  assert.ok(takenName.includes('file.parent_path === parentPath'), 'name collision checks use canonical parent paths');
  assert.ok(!takenName.includes("file.item_type !== 'folder'"), 'folder names count as occupied under the server unique-name rule');
}

function testViewsRenderCanonicalRecordIdsAndTypes() {
  const desktop = section(html, 'function refreshDesktopIcons() {', 'function netshiftCoreRenderDesktopFile(');
  assert.ok(desktop.includes('NETSHIFT_CORE_SOFTWARE'), 'Desktop installed-software view uses canonical software rows');
  assert.ok(desktop.includes('!netshiftCoreIsShadowedLegacyFile(file)'), 'Desktop filters only legacy demo/duplicate files');
  assert.ok(!desktop.includes("file.name !== 'bank-info.txt'"), 'Desktop does not hide a legitimate canonical bank-info.txt record');
  assert.ok(desktop.includes('data-core-record-id='), 'canonical software DOM retains its server record ID');
  assert.ok(desktop.includes('netshiftCoreRenderDesktopFile(file)'), 'canonical desktop files render from the file model');

  const explorer = section(html, 'renderExplorerContent = function renderExplorerContent()', 'netshiftRenderUserFolders = function netshiftRenderUserFolders()');
  for (const marker of [
    "if (folder === 'recycle')", "netshiftCoreSoftwareRowsForView('desktop')",
    "netshiftCoreSoftwareAt('downloads')", "netshiftCoreSoftwareAt('archive')",
    "folder.startsWith('custom:')", 'NETSHIFT_CORE_FOLDERS', 'renderLocalFileRowV16'
  ]) assert.ok(explorer.includes(marker), `Explorer has canonical view marker ${marker}`);
  assert.ok(explorer.includes('!netshiftCoreIsShadowedLegacyFile(file)'), 'Explorer avoids duplicate legacy file mirrors');

  const shadowSection = section(html, 'function netshiftCoreIsShadowedLegacyFile(', 'function renderLocalFileRowV16(');
  const shadowedFile = new Function('window', 'NETSHIFT_CORE_FILES', 'netshiftCoreEffectiveFileLocation', 'netshiftCoreFolderLocation',
    `${shadowSection}\nreturn netshiftCoreIsShadowedLegacyFile;`);
  const authenticatedWindow = { NETSHIFT_USER: { id: 'user-a' } };
  const canonicalBankInfo = { id: 'bank-info-canonical', item_type: 'file', name: 'bank-info.txt', parent_path: '/' };
  const shadowHelper = shadowedFile(authenticatedWindow, [canonicalBankInfo], file => file?._coreFileId ? 'desktop' : 'desktop', value => value === '/' ? 'desktop' : value);
  assert.equal(shadowHelper({ name: 'bank-info.txt', content: 'fictional legacy credentials' }, [canonicalBankInfo]), true,
    'authenticated hydration excludes the legacy bank-info demo contents');
  assert.equal(shadowHelper({ _coreFileId: 'bank-info-canonical', name: 'bank-info.txt' }, [canonicalBankInfo]), false,
    'a canonical server-owned bank-info.txt row remains visible');
  const canonicalNote = { id: 'note-canonical', item_type: 'file', name: 'notes.txt', parent_path: '/' };
  assert.equal(shadowHelper({ name: 'notes.txt' }, [canonicalNote]), true,
    'a duplicate legacy mirror is shadowed when it matches a canonical filename and location');
  assert.equal(shadowHelper({ name: 'other.txt' }, [canonicalNote]), false,
    'unrelated legacy-only file rows are not hidden by canonical inventory');

  const softwareSection = section(html, 'function netshiftCoreRenderSoftwareRow(item, location) {', 'function netshiftCoreRenderFolderRow(');
  const softwareRenderer = new Function('software', 'netshiftCoreInlineArg', 'esc', 'renderSoftwareRowV16',
    `${softwareSection}\nreturn netshiftCoreRenderSoftwareRow;`)(registry, helpers.netshiftCoreInlineArg, htmlEscape, () => '<legacy>');
  const archiveRow = softwareRenderer({ _coreFileId: 'row-archive', softwareId: 'crc1', name: 'Password Cracker L1.exe', _coreSoftwareLevel: 1 }, 'archive');
  assert.ok(archiveRow.includes("netshiftCoreItemAction('install'"), 'double-clicking archived software requests installation');
  assert.ok(!archiveRow.includes('ondblclick="runSoftware'), 'archived software is not presented as already installed');
  const downloadRow = softwareRenderer({ _coreFileId: 'row-download', softwareId: 'wwl1', name: 'Waterwall L1.exe', _coreSoftwareLevel: 1 }, 'downloads');
  assert.ok(downloadRow.includes("netshiftCoreItemAction('install'"), 'double-clicking downloaded software requests installation');
  const desktopRow = softwareRenderer({ _coreFileId: 'row-installed', softwareId: 'crc1', name: 'Password Cracker L1.exe', _coreSoftwareLevel: 1 }, 'desktop');
  assert.ok(desktopRow.includes('ondblclick="runSoftware'), 'Desktop software is presented as installed/runnable');
  const unknownRow = softwareRenderer({ _coreFileId: 'unknown-record-id', softwareId: null, name: 'utility-not-in-catalogue.bin', _coreSoftwareLevel: 4 }, 'archive');
  assert.ok(unknownRow.includes('utility-not-in-catalogue.bin'), 'unknown canonical software displays its real server filename');
  assert.ok(unknownRow.includes('data-core-record-id="unknown-record-id"'), 'unknown software remains tied to its server row');

  const recycleSection = section(html, 'renderRecycleRowV16 = function renderRecycleRowV16(', 'renderExplorerContent = function renderExplorerContent()');
  const recycleRenderer = new Function('software', 'esc', 'button',
    `${recycleSection}\nreturn renderRecycleRowV16;`)(registry, htmlEscape, (label, action) => `<button onclick="${action}">${label}</button>`);
  const recycledUnknownSoftware = recycleRenderer({
    type: 'software', _coreItemType: 'software', _coreFileId: 'recycled-uuid', id: 'mystery-id',
    item: { name: 'renamed-unknown.payload', _coreItemType: 'software' }, deletedAt: '2026-10-13T10:00:00Z'
  }, 0);
  assert.ok(recycledUnknownSoftware.includes('<strong>renamed-unknown.payload</strong>'), 'Recycle Bin renders the stored software name, including unknown families');
  assert.ok(recycledUnknownSoftware.includes('data-core-record-id="recycled-uuid"'), 'Recycle Bin DOM retains canonical ID');
  assert.ok(recycledUnknownSoftware.includes('Software · Deleted'), 'Recycle Bin communicates authoritative item type');
  const recycledFolder = recycleRenderer({ type: 'folder', _coreFileId: 'folder-uuid', item: { name: 'OldFolder' } }, 1);
  assert.ok(recycledFolder.includes('Folder · Deleted'), 'Recycle Bin identifies folders by type');
}

function testServerAuthoritativeSoftwareLocationEndpoint() {
  const route = section(server, "app.patch('/api/core/files/:id/location'", "app.post('/api/core/files'");
  for (const marker of [
    'requireAuth', 'requireSessionOwnership(req, res)', "item_type='software'",
    'user_id=$2', 'await client.query(\'BEGIN\')', 'pg_advisory_xact_lock',
    'playerFileParentExists(req.session.user.id, parent, client)', "destination = parent === '/' ? '/desktop' : parent",
    "destination = '/archive'", "UPDATE netshift_player_files SET parent_path=$3", "await client.query('COMMIT')"
  ]) assert.ok(route.includes(marker), `software-location API enforces ${marker}`);
  assert.ok(route.includes("if (error.code === '23505') return res.status(409)"), 'name conflicts roll the transaction back and return a conflict');
  assert.ok(route.includes('finally { client.release(); }'), 'database client is released after all route outcomes');

  const restore = section(server, "app.post('/api/core/files/:id/restore'", "app.delete('/api/core/files/:id/permanent'");
  for (const marker of [
    'requireSessionOwnership(req, res)', 'user_id=$2', 'recycle_bin_at IS NOT NULL',
    "await c.query('BEGIN')", 'pg_advisory_xact_lock', 'FOR UPDATE',
    "destination = '/archive'", "UPDATE netshift_player_files SET recycle_bin_at=NULL,parent_path=$3",
    "await c.query('COMMIT')", "await c.query('ROLLBACK')"
  ]) assert.ok(restore.includes(marker), `restore enforces ${marker}`);
  assert.ok(restore.includes('A higher-level copy is already installed'), 'restore retains installed-level precedence');

  const recycle = section(server, "app.delete('/api/core/files/:id'", "app.post('/api/core/files/:id/restore'");
  assert.ok(recycle.includes("item_type IN ('file','software')"), 'folders cannot be recycled through the generic delete endpoint');
  assert.ok(recycle.includes('Folder deletion is disabled'), 'unsupported folder deletion fails closed on the server');
  const permanent = section(server, "app.delete('/api/core/files/:id/permanent'", "app.post('/api/core/hosts/:slug/download'");
  assert.ok(permanent.includes("item_type IN ('file','software')"), 'folders cannot be permanently deleted through the generic endpoint');
  assert.ok(permanent.includes('Folder deletion is disabled'), 'permanent folder deletion is explicitly refused');

  const pathValidation = section(server, 'function validPlayerFileName(name) {', 'async function playerFileParentExists(');
  const pathHelpers = new Function(`${pathValidation}\nreturn { validPlayerFileName, validPlayerFileParent };`)();
  for (const valid of ['/', '/desktop', '/downloads', '/archive', '/Reports', '/Reports/2026 Q4']) {
    assert.equal(pathHelpers.validPlayerFileParent(valid), true, `valid canonical parent: ${valid}`);
  }
  for (const invalid of ['/Reports/', '/Reports//2026', '//downloads', '/Reports/../Archive', '/Reports\\escape', '/Reports/ trailing']) {
    assert.equal(pathHelpers.validPlayerFileParent(invalid), false, `invalid non-canonical parent is rejected: ${invalid}`);
  }
}

function testCheckCommandIncludesThisTest() {
  assert.ok(pkg.scripts.check.includes('node scripts/check-stage1-canonical-inventory.js'),
    'canonical inventory check is wired into npm run check');
}

testCanonicalMappingHelpers();
testInventoryHydrationKeepsTypesAndCanonicalCollectionsSeparate();
testViewsRenderCanonicalRecordIdsAndTypes();
testServerAuthoritativeSoftwareLocationEndpoint();
testCheckCommandIncludesThisTest();
console.log('Stage 1 canonical inventory checks OK (typed mapping, canonical view models, Desktop/Explorer/Recycle Bin rendering and owner-scoped software movement).');
