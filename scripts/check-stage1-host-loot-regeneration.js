'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  HOST_STOCK_LIMITS,
  SOFTWARE_LEVEL_WEIGHTS_BY_FIREWALL,
  SOFTWARE_LOOT_TABLE,
  FILE_LOOT_TABLE,
  getHostStockLimit,
  chooseSoftwareLevel,
  createGeneratedHostLoot,
  isGeneratedHostLoot,
  compactStockToCapacity,
  removeHostStockItem,
  regenerateHostStock
} = require('../lib/host-loot-regeneration');

const root = path.join(__dirname, '..');
const serverSource = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const claimSource = fs.readFileSync(path.join(root, 'lib', 'host-download-claim.js'), 'utf8');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

function sequenceRandom(values) {
  let index = 0;
  return () => {
    if (index >= values.length) throw new Error('Deterministic random sequence exhausted.');
    return values[index++];
  };
}

function idSequence() {
  let index = 0;
  return () => `test-id-${++index}`;
}

function testStockPolicyAndFirewallWeights() {
  assert.deepEqual(HOST_STOCK_LIMITS, { website: 3, npc_workstation: 5 });
  assert.equal(getHostStockLimit('website'), 3);
  assert.equal(getHostStockLimit('npc_workstation'), 5);
  assert.equal(getHostStockLimit('unexpected'), 3, 'unknown target types fail safe to the smaller website cap');

  for (let firewall = 0; firewall <= 5; firewall++) {
    assert.equal(SOFTWARE_LEVEL_WEIGHTS_BY_FIREWALL[firewall].reduce((a, b) => a + b, 0), 100);
  }
  assert.deepEqual(SOFTWARE_LEVEL_WEIGHTS_BY_FIREWALL[0], [96, 4, 0, 0, 0]);
  assert.ok(SOFTWARE_LEVEL_WEIGHTS_BY_FIREWALL[5][0] > 0, 'L1 remains possible at highest security');
  assert.ok(SOFTWARE_LEVEL_WEIGHTS_BY_FIREWALL[5][0] > SOFTWARE_LEVEL_WEIGHTS_BY_FIREWALL[5][4], 'L1 is individually more common than L5');
  const highSecurityChance = SOFTWARE_LEVEL_WEIGHTS_BY_FIREWALL[5].slice(1).reduce((a, b) => a + b, 0);
  const lowSecurityChance = SOFTWARE_LEVEL_WEIGHTS_BY_FIREWALL[0].slice(1).reduce((a, b) => a + b, 0);
  assert.ok(highSecurityChance > lowSecurityChance, 'higher-firewall targets increase the chance of better software');
  assert.equal(chooseSoftwareLevel(0, () => 0.99), 2);
  assert.equal(chooseSoftwareLevel(5, () => 0.99), 5);
  assert.ok(SOFTWARE_LOOT_TABLE.length >= 8, 'software loot table should provide family variety');
  assert.ok(FILE_LOOT_TABLE.length >= 3, 'file loot table should include multiple text loot types');
}

function testWeightedLootHasTrustedMetadataAndUniqueIdentity() {
  const target = { slug: 'crown', name: 'Crown Reserve Bank', targetType: 'website', securityLevel: 5 };
  const highLoot = createGeneratedHostLoot(target, {
    now: new Date('2026-10-13T12:00:00.000Z'),
    idFactory: idSequence(),
    random: sequenceRandom([0.99, 0.01, 0.99])
  });
  assert.equal(highLoot.type, 'software');
  assert.equal(highLoot.family, 'crc');
  assert.equal(highLoot.level, 5);
  assert.equal(highLoot.name, 'Password Cracker L5.exe');
  assert.equal(highLoot.generated, true);
  assert.equal(highLoot.lootTable, true);
  assert.equal(highLoot.generatedAt, '2026-10-13T12:00:00.000Z');
  assert.match(highLoot.id, /^crown-loot-/);
  assert.ok(isGeneratedHostLoot(highLoot, 'crown'));

  const fileLoot = createGeneratedHostLoot({ ...target, securityLevel: 0 }, {
    now: new Date('2026-10-13T12:01:00.000Z'),
    idFactory: idSequence(),
    random: sequenceRandom([0.01, 0.01])
  });
  assert.equal(fileLoot.type, 'file');
  assert.match(fileLoot.name, /^[a-z-]+-[a-z0-9]+\.txt$/);
  assert.match(fileLoot.content, /no credentials are included/i);
  assert.ok(isGeneratedHostLoot(fileLoot, 'crown'));
}

function testLegacyOverfullInventoryCompactsAndRotatesOldestGeneratedLoot() {
  const slug = 'finance';
  const stock = [
    { id: 'finance-readme', name: 'README.txt', type: 'file', content: 'static', static: true },
    { id: 'finance-warez1', name: 'Warez Virus L1.vshare', type: 'software', family: 'warez', level: 1 },
    ...Array.from({ length: 40 }, (_, i) => ({
      id: `finance-warez1-${Math.floor(Date.parse('2026-10-01T00:00:00.000Z') / 300000) + i}`,
      name: 'Warez Virus L1.vshare', type: 'software', family: 'warez', level: 1
    }))
  ];
  assert.equal(stock.length, 42);
  assert.ok(isGeneratedHostLoot(stock[1], slug), 'legacy fixed Warez seed is treated as the replaceable legacy loot slot');

  const regenerated = regenerateHostStock(stock, {
    slug, name: 'Small Finance Co.', targetType: 'website', securityLevel: 0
  }, {
    now: new Date('2026-10-13T12:05:00.000Z'),
    idFactory: idSequence(),
    random: sequenceRandom([0.99, 0.01, 0.01])
  });

  assert.equal(regenerated.limit, 3);
  assert.equal(regenerated.stock.length, 3, 'overfull legacy inventory is compacted to website stock limit');
  assert.ok(regenerated.stock.some(item => item.id === 'finance-readme'), 'static site content remains');
  assert.ok(regenerated.spawned);
  assert.ok(regenerated.stock.some(item => item.id === regenerated.spawned.id));
  assert.ok(!regenerated.stock.some(item => item.id === 'finance-warez1'), 'old legacy loot slot is replaced');
  assert.ok(!regenerated.stock.some(item => item.id === stock[2].id), 'oldest legacy generated items are pruned during recovery');
}

function testInventoryCapsAndOldestGeneratedReplacement() {
  const websiteStock = [
    { id: 'site-readme', name: 'README.txt', type: 'file' },
    { id: 'site-old', name: 'Warez Virus L1.vshare', type: 'software', family: 'warez', level: 1, generated: true, generatedAt: '2026-10-13T11:00:00.000Z' },
    { id: 'site-new', name: 'Password Cracker L2.exe', type: 'software', family: 'crc', level: 2, generated: true, generatedAt: '2026-10-13T11:04:00.000Z' }
  ];
  const website = regenerateHostStock(websiteStock, {
    slug: 'pawperfect', name: 'PawPerfect', targetType: 'website', securityLevel: 1
  }, {
    now: new Date('2026-10-13T11:05:00.000Z'), idFactory: idSequence(), random: sequenceRandom([0.99, 0.01, 0.01])
  });
  assert.equal(website.stock.length, 3);
  assert.ok(!website.stock.some(item => item.id === 'site-old'), 'oldest generated website loot is replaced');
  assert.ok(website.stock.some(item => item.id === 'site-new'), 'newer loot is retained');

  const npcStock = [
    { id: 'npc-readme', name: 'README.txt', type: 'file' },
    ...Array.from({ length: 4 }, (_, i) => ({
      id: `npc-item-${i + 1}`, name: `Password Cracker L${i + 1}.exe`, type: 'software', family: 'crc', level: i + 1,
      generated: true, generatedAt: new Date(Date.parse('2026-10-13T11:00:00.000Z') + i * 60000).toISOString()
    }))
  ];
  const npc = regenerateHostStock(npcStock, {
    slug: 'hacker', name: 'Forgetful Hacker', targetType: 'npc_workstation', securityLevel: 1
  }, {
    now: new Date('2026-10-13T11:05:00.000Z'), idFactory: idSequence(), random: sequenceRandom([0.99, 0.01, 0.01])
  });
  assert.equal(npc.stock.length, 5);
  assert.ok(!npc.stock.some(item => item.id === 'npc-item-1'), 'oldest generated NPC loot is replaced');
  assert.ok(npc.stock.some(item => item.id === 'npc-item-4'), 'newer NPC loot is retained');
}

function testAuthoritativeRemovalAndRegenerationStaticWiring() {
  const stock = [
    { id: 'keep', name: 'README.txt', type: 'file' },
    { id: 'remove', name: 'Password Cracker L1.exe', type: 'software', family: 'crc', level: 1 }
  ];
  const removal = removeHostStockItem(stock, 'remove');
  assert.equal(removal.changed, true);
  assert.equal(removal.removed.id, 'remove');
  assert.deepEqual(removal.stock.map(item => item.id), ['keep']);
  assert.equal(removeHostStockItem(removal.stock, 'missing').changed, false);

  assert.ok(serverSource.includes("target_type VARCHAR(24) NOT NULL DEFAULT 'website'"), 'target class is persisted on world hosts');
  assert.ok(serverSource.includes("target_type = EXCLUDED.target_type"), 'seed upsert refreshes website/NPC host classification');
  assert.ok(serverSource.includes('FOR UPDATE OF h SKIP LOCKED'), 'regeneration safely locks due host inventory rows');
  assert.ok(serverSource.includes('regenerateHostStock(stock'), 'server ticker delegates stock policy to tested helper');
  assert.ok(claimSource.includes("require('./host-loot-regeneration')"), 'claims and future system removals share the authoritative stock-removal helper');
  assert.ok(claimSource.includes('removeHostStockItem(rawStock, itemId)'), 'successful claim removes its item from canonical stock');
  assert.ok(pkg.scripts.check.includes('node scripts/check-stage1-host-loot-regeneration.js'), 'regeneration checks are part of npm run check');
}

(function main() {
  testStockPolicyAndFirewallWeights();
  testWeightedLootHasTrustedMetadataAndUniqueIdentity();
  testLegacyOverfullInventoryCompactsAndRotatesOldestGeneratedLoot();
  testInventoryCapsAndOldestGeneratedReplacement();
  testAuthoritativeRemovalAndRegenerationStaticWiring();
  console.log('Stage 1 host-loot regeneration checks OK (firewall-weighted loot table, 3/5 stock limits, oldest generated replacement, legacy over-cap recovery, and authoritative removal).');
})();
