'use strict';

const crypto = require('node:crypto');

const HOST_STOCK_LIMITS = Object.freeze({
  website: 3,
  npc_workstation: 5
});

// The chance of a higher software version increases with target firewall/security
// level, but L1 remains the single most common software level and L5 remains rare.
// Each row's weights total 100 and correspond to software levels [1, 2, 3, 4, 5].
const SOFTWARE_LEVEL_WEIGHTS_BY_FIREWALL = Object.freeze({
  0: Object.freeze([96, 4, 0, 0, 0]),
  1: Object.freeze([86, 12, 2, 0, 0]),
  2: Object.freeze([72, 19, 7, 2, 0]),
  3: Object.freeze([60, 23, 11, 5, 1]),
  4: Object.freeze([50, 24, 15, 8, 3]),
  5: Object.freeze([40, 26, 18, 11, 5])
});

// Family weights are a separate loot-table roll from version level. This provides
// meaningful family variety without letting the client supply any canonical metadata.
const SOFTWARE_LOOT_TABLE = Object.freeze([
  Object.freeze({ family: 'crc', name: 'Password Cracker', extension: '.exe', weight: 18 }),
  Object.freeze({ family: 'wwl', name: 'Waterwall', extension: '.exe', weight: 15 }),
  Object.freeze({ family: 'warez', name: 'Warez Virus', extension: '.vshare', weight: 14 }),
  Object.freeze({ family: 'fc', name: 'FTPCash', extension: '.exe', weight: 10 }),
  Object.freeze({ family: 'uploader', name: 'nefariousUploader', extension: '.exe', weight: 11 }),
  Object.freeze({ family: 'av', name: 'Anti-Malware', extension: '.exe', weight: 13 }),
  Object.freeze({ family: 'extractor', name: 'Virus Extractor', extension: '.exe', weight: 6 }),
  Object.freeze({ family: 'embedder', name: 'Virus Embedder', extension: '.exe', weight: 6 }),
  Object.freeze({ family: 'popup', name: 'Popup Spammer', extension: '.vspam', weight: 7 })
]);

const FILE_LOOT_TABLE = Object.freeze([
  Object.freeze({ stem: 'network-map', weight: 35, description: 'A short public network map.' }),
  Object.freeze({ stem: 'maintenance-notes', weight: 30, description: 'Routine maintenance notes.' }),
  Object.freeze({ stem: 'incident-report', weight: 20, description: 'A fictional incident summary.' }),
  Object.freeze({ stem: 'service-catalogue', weight: 15, description: 'A public service catalogue.' })
]);
const GENERATED_FILE_CHANCE = 0.12;

function getHostStockLimit(targetType) {
  return HOST_STOCK_LIMITS[targetType] || HOST_STOCK_LIMITS.website;
}

function randomUnit(random) {
  const value = Number(random());
  if (!Number.isFinite(value) || value < 0 || value >= 1) {
    throw new TypeError('Loot random source must return a number in [0, 1).');
  }
  return value;
}

function weightedPick(entries, random) {
  if (!Array.isArray(entries) || entries.length === 0) throw new TypeError('Loot table is empty.');
  const total = entries.reduce((sum, entry) => sum + entry.weight, 0);
  if (!(total > 0)) throw new TypeError('Loot table has no positive weights.');
  let roll = randomUnit(random) * total;
  for (const entry of entries) {
    roll -= entry.weight;
    if (roll < 0 && entry.weight > 0) return entry;
  }
  return entries.filter(entry => entry.weight > 0).at(-1);
}

function chooseSoftwareLevel(firewallLevel, random = Math.random) {
  const level = Math.max(0, Math.min(5, Number.isInteger(Number(firewallLevel)) ? Number(firewallLevel) : 0));
  const weights = SOFTWARE_LEVEL_WEIGHTS_BY_FIREWALL[level];
  const entries = weights.map((weight, index) => ({ level: index + 1, weight }));
  return weightedPick(entries, random).level;
}

function makeGeneratedId(slug, idFactory = crypto.randomUUID) {
  return `${slug}-loot-${idFactory()}`;
}

function createGeneratedHostLoot(target, {
  now = new Date(),
  idFactory = crypto.randomUUID,
  random = Math.random
} = {}) {
  if (!target || typeof target.slug !== 'string' || !/^[a-z0-9-]{1,40}$/.test(target.slug)) {
    throw new TypeError('A valid host slug is required to create loot.');
  }
  const timestamp = (now instanceof Date ? now : new Date(now)).toISOString();
  const id = makeGeneratedId(target.slug, idFactory);

  if (randomUnit(random) < GENERATED_FILE_CHANCE) {
    const file = weightedPick(FILE_LOOT_TABLE, random);
    const suffix = idFactory().replace(/[^a-z0-9]/gi, '').slice(0, 6).toLowerCase();
    return {
      id,
      name: `${file.stem}-${suffix}.txt`,
      type: 'file',
      content: `${file.description}\nHost: ${String(target.name || target.slug)}\nSecurity rating: ${Number(target.securityLevel) || 0}/5\nGenerated host loot; no credentials are included.`,
      generated: true,
      generatedAt: timestamp,
      lootTable: true
    };
  }

  const family = weightedPick(SOFTWARE_LOOT_TABLE, random);
  const level = chooseSoftwareLevel(target.securityLevel, random);
  return {
    id,
    name: `${family.name} L${level}${family.extension}`,
    type: 'software',
    family: family.family,
    level,
    generated: true,
    generatedAt: timestamp,
    lootTable: true
  };
}

function legacyGeneratedTimestamp(item, slug) {
  // Older ticker versions named regenerated Warez rows as `${slug}-warez1-<epoch/300>`.
  // Interpret those as generated entries so a one-time cap recovery can prune the old pile.
  const escaped = String(slug).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = typeof item?.id === 'string'
    ? item.id.match(new RegExp(`^${escaped}-warez1(?:-(\\d+))?$`))
    : null;
  if (!match) return null;
  return match[1] ? Number(match[1]) * 300000 : 0;
}

function isGeneratedHostLoot(item, slug) {
  return item?.generated === true ||
    (typeof item?.generatedAt === 'string' && Number.isFinite(Date.parse(item.generatedAt))) ||
    legacyGeneratedTimestamp(item, slug) !== null;
}

function generatedTime(item, slug) {
  if (typeof item?.generatedAt === 'string' && Number.isFinite(Date.parse(item.generatedAt))) {
    return Date.parse(item.generatedAt);
  }
  const legacy = legacyGeneratedTimestamp(item, slug);
  return legacy === null ? 0 : legacy;
}

function compactStockToCapacity(stock, { slug, targetType }) {
  const limit = getHostStockLimit(targetType);
  if (!Array.isArray(stock)) throw new TypeError('Host stock must be an array.');
  const staticItems = [];
  const generatedItems = [];
  const seenIds = new Set();
  for (const item of stock) {
    if (!item || typeof item !== 'object' || typeof item.id !== 'string' || !item.id) {
      throw new TypeError('Host stock contains a malformed item.');
    }
    if (seenIds.has(item.id)) continue;
    seenIds.add(item.id);
    (isGeneratedHostLoot(item, slug) ? generatedItems : staticItems).push(item);
  }
  // Preserve stable/static site content first; among loot-table entries retain the newest.
  const retainedStatic = staticItems.slice(0, limit);
  const roomForGenerated = Math.max(0, limit - retainedStatic.length);
  const retainedGenerated = generatedItems
    .sort((a, b) => generatedTime(b, slug) - generatedTime(a, slug))
    .slice(0, roomForGenerated)
    .sort((a, b) => generatedTime(a, slug) - generatedTime(b, slug));
  return [...retainedStatic, ...retainedGenerated];
}

function removeHostStockItem(stock, itemId) {
  if (!Array.isArray(stock)) throw new TypeError('Host stock must be an array.');
  const index = stock.findIndex(item => item?.id === itemId);
  if (index < 0) return { stock: stock.slice(), removed: null, changed: false };
  const next = stock.slice();
  const [removed] = next.splice(index, 1);
  return { stock: next, removed, changed: true };
}

function regenerateHostStock(stock, target, {
  now = new Date(),
  idFactory = crypto.randomUUID,
  random = Math.random
} = {}) {
  const limit = getHostStockLimit(target?.targetType || target?.target_type);
  const compacted = compactStockToCapacity(stock, {
    slug: target.slug,
    targetType: target.targetType || target.target_type
  });
  let next = compacted;
  let changed = compacted.length !== stock.length || compacted.some((item, i) => item.id !== stock[i]?.id);

  if (next.length >= limit) {
    // Refresh a full inventory by replacing its oldest generated item, never fixed site content.
    let oldestIndex = -1;
    let oldestAt = Infinity;
    for (let i = 0; i < next.length; i++) {
      if (!isGeneratedHostLoot(next[i], target.slug)) continue;
      const time = generatedTime(next[i], target.slug);
      if (time < oldestAt) { oldestAt = time; oldestIndex = i; }
    }
    if (oldestIndex < 0) {
      // Should not occur with a generated slot, but do not delete static content to make room.
      return { stock: next, changed, spawned: null, limit, reason: 'NO_REPLACEABLE_LOOT' };
    }
    next = next.slice();
    next.splice(oldestIndex, 1);
    changed = true;
  }

  const spawned = createGeneratedHostLoot({
    slug: target.slug,
    name: target.name,
    securityLevel: target.securityLevel ?? target.security_level
  }, { now, idFactory, random });
  next.push(spawned);
  if (next.length > limit) throw new Error('Host loot regeneration exceeded the stock limit.');
  return { stock: next, changed: true, spawned, limit, reason: 'SPAWNED' };
}

module.exports = {
  HOST_STOCK_LIMITS,
  SOFTWARE_LEVEL_WEIGHTS_BY_FIREWALL,
  SOFTWARE_LOOT_TABLE,
  FILE_LOOT_TABLE,
  GENERATED_FILE_CHANCE,
  getHostStockLimit,
  chooseSoftwareLevel,
  createGeneratedHostLoot,
  isGeneratedHostLoot,
  compactStockToCapacity,
  removeHostStockItem,
  regenerateHostStock
};
