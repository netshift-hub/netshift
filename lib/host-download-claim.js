'use strict';

const crypto = require('node:crypto');

class HostDownloadClaimError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'HostDownloadClaimError';
    this.status = status;
    this.code = code;
  }
}

const HOST_SLUG_RE = /^[a-z0-9-]{1,40}$/;
const HOST_ITEM_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,119}$/;
const SOFTWARE_FAMILY_RE = /^[a-z][a-z0-9_-]{0,39}$/i;

function assertHostSlug(slug) {
  if (typeof slug !== 'string' || !HOST_SLUG_RE.test(slug)) {
    throw new HostDownloadClaimError(400, 'INVALID_HOST', 'Invalid host identifier.');
  }
  return slug;
}

function assertHostItemId(itemId) {
  if (typeof itemId !== 'string' || !HOST_ITEM_ID_RE.test(itemId) || itemId.trim() !== itemId) {
    throw new HostDownloadClaimError(400, 'INVALID_ITEM_ID', 'Invalid host item identifier.');
  }
  return itemId;
}

function normaliseHostStock(stock, validPlayerFileName) {
  if (!Array.isArray(stock)) {
    throw new HostDownloadClaimError(500, 'HOST_STOCK_INVALID', 'Host inventory is temporarily unavailable.');
  }
  const ids = new Set();
  return stock.map(raw => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new HostDownloadClaimError(500, 'HOST_STOCK_INVALID', 'Host inventory is temporarily unavailable.');
    }
    if (typeof raw.id !== 'string' || !HOST_ITEM_ID_RE.test(raw.id) || raw.id.trim() !== raw.id || ids.has(raw.id)) {
      throw new HostDownloadClaimError(500, 'HOST_STOCK_INVALID', 'Host inventory is temporarily unavailable.');
    }
    ids.add(raw.id);
    if (typeof raw.name !== 'string' || !validPlayerFileName(raw.name)) {
      throw new HostDownloadClaimError(500, 'HOST_STOCK_INVALID', 'Host inventory is temporarily unavailable.');
    }
    if (!['file', 'software'].includes(raw.type)) {
      throw new HostDownloadClaimError(500, 'HOST_STOCK_INVALID', 'Host inventory is temporarily unavailable.');
    }
    if (raw.content !== undefined && raw.content !== null && typeof raw.content !== 'string') {
      throw new HostDownloadClaimError(500, 'HOST_STOCK_INVALID', 'Host inventory is temporarily unavailable.');
    }
    if (raw.type === 'software') {
      if (typeof raw.family !== 'string' || !SOFTWARE_FAMILY_RE.test(raw.family) ||
          !Number.isInteger(raw.level) || raw.level < 1 || raw.level > 6) {
        throw new HostDownloadClaimError(500, 'HOST_STOCK_INVALID', 'Host inventory is temporarily unavailable.');
      }
    }
    // Do not infer software family/level from the filename or file extension. Only
    // trusted host-stock fields determine canonical type and software metadata.
    return {
      id: raw.id,
      name: raw.name,
      type: raw.type,
      content: typeof raw.content === 'string' ? raw.content : '',
      family: raw.type === 'software' ? raw.family : null,
      level: raw.type === 'software' ? raw.level : null,
      credential: raw.credential === true || /account|bank|credential/i.test(raw.name)
    };
  });
}

function publicHostStockItem(item) {
  const safe = { id: item.id, name: item.name, type: item.type };
  if (item.type === 'software') {
    safe.family = item.family;
    safe.level = item.level;
  }
  return safe;
}

/**
 * Claim one trusted host-stock item and deliver it to the authenticated player's
 * canonical /downloads inventory as one PostgreSQL transaction.
 *
 * Lock order is account ownership -> shared target -> host inventory. The breach
 * route already follows ownership -> target -> host inventory, so this avoids
 * introducing an inverse target/inventory lock order.
 */
async function claimHostDownload(pool, { userId, sessionId, slug, itemId, validPlayerFileName }) {
  assertHostSlug(slug);
  assertHostItemId(itemId);
  if (typeof validPlayerFileName !== 'function') throw new TypeError('validPlayerFileName validator is required');

  const client = await pool.connect();
  let transactionOpen = false;
  try {
    await client.query('BEGIN');
    transactionOpen = true;

    const ownership = await client.query(
      'SELECT session_id FROM netshift_account_ownership WHERE user_id = $1 FOR UPDATE', [userId]);
    if (!ownership.rowCount || ownership.rows[0].session_id !== sessionId) {
      throw new HostDownloadClaimError(401, 'SESSION_REVOKED', 'This session no longer owns the account. Sign in again.');
    }
    await client.query('UPDATE netshift_account_ownership SET last_seen_at = NOW() WHERE user_id = $1', [userId]);

    const target = await client.query(`SELECT slug, name, compromised_by_user_id
      FROM netshift_world_targets WHERE slug=$1 FOR UPDATE`, [slug]);
    if (!target.rowCount) {
      throw new HostDownloadClaimError(404, 'HOST_NOT_FOUND', 'That shared host was not found.');
    }
    if (String(target.rows[0].compromised_by_user_id ?? '') !== String(userId)) {
      throw new HostDownloadClaimError(403, 'HOST_ACCESS_REQUIRED', 'You must control this host before downloading its files.');
    }

    const host = await client.query(`SELECT target_slug, stock, inventory_version, credential_lock_until
      FROM netshift_world_host_inventory WHERE target_slug=$1 FOR UPDATE`, [slug]);
    if (!host.rowCount) {
      throw new HostDownloadClaimError(404, 'HOST_INVENTORY_NOT_FOUND', 'Host inventory is not available.');
    }
    const rawStock = host.rows[0].stock;
    const stock = normaliseHostStock(rawStock, validPlayerFileName);
    const item = stock.find(entry => entry.id === itemId);
    if (!item) {
      throw new HostDownloadClaimError(409, 'ITEM_NOT_AVAILABLE', 'This item is no longer available on the host. Refresh the inventory and try again.');
    }

    // Item IDs represent a single stock instance. Regenerated items receive fresh
    // IDs; if a stale ID appears in stock again, refuse it instead of awarding it twice.
    const priorClaim = await client.query(`SELECT id FROM netshift_world_loot_claims
      WHERE target_slug=$1 AND item_key=$2 LIMIT 1`, [slug, itemId]);
    if (priorClaim.rowCount) {
      throw new HostDownloadClaimError(409, 'ITEM_ALREADY_CLAIMED', 'This item ID has already been claimed. Refresh the inventory.');
    }

    const nextRawStock = rawStock.filter(entry => entry.id !== itemId);
    if (nextRawStock.length !== rawStock.length - 1) {
      throw new HostDownloadClaimError(500, 'HOST_STOCK_INVALID', 'Host inventory is temporarily unavailable.');
    }
    const credential = item.credential;
    const updatedHost = await client.query(`UPDATE netshift_world_host_inventory
      SET stock=$2::jsonb, inventory_version=inventory_version+1,
        last_intrusion_at=COALESCE(last_intrusion_at,NOW()),
        next_regen_at=COALESCE(next_regen_at,NOW()+INTERVAL '5 minutes'),
        credential_lock_until=CASE WHEN $3 THEN NOW()+INTERVAL '3 days' ELSE credential_lock_until END
      WHERE target_slug=$1 AND inventory_version=$4
      RETURNING inventory_version, next_regen_at`,
      [slug, JSON.stringify(nextRawStock), credential, host.rows[0].inventory_version]);
    if (!updatedHost.rowCount) throw new Error('Host inventory changed unexpectedly during a locked claim.');

    const claim = await client.query(`INSERT INTO netshift_world_loot_claims
      (target_slug,item_key,claimed_by_user_id,regen_after)
      VALUES ($1,$2,$3,NOW()+INTERVAL '5 minutes') RETURNING id,item_key`, [slug, itemId, userId]);
    if (!claim.rowCount) throw new Error('Host claim ledger did not record the claim.');

    const fileId = crypto.randomUUID();
    const itemType = item.type;
    const mimeType = itemType === 'software' ? 'application/octet-stream' : 'text/plain';
    const inserted = await client.query(`INSERT INTO netshift_player_files
      (id,user_id,parent_path,name,item_type,mime_type,content,software_family,software_level)
      VALUES($1,$2,'/downloads',$3,$4,$5,$6,$7,$8)
      RETURNING id,user_id,parent_path,name,item_type,mime_type,content,software_family,software_level,created_at,updated_at`,
      [fileId, userId, item.name, itemType, mimeType, item.content, item.family, item.level]);
    if (!inserted.rowCount) throw new Error('Canonical player inventory did not accept the downloaded item.');

    await client.query('COMMIT');
    transactionOpen = false;
    return {
      host: { slug, name: target.rows[0].name },
      item: publicHostStockItem(item),
      file: inserted.rows[0],
      inventoryVersion: String(updatedHost.rows[0].inventory_version),
      regenAt: updatedHost.rows[0].next_regen_at || null,
      claimId: String(claim.rows[0].id)
    };
  } catch (error) {
    if (transactionOpen) {
      try { await client.query('ROLLBACK'); } catch (_) { /* preserve original error */ }
      transactionOpen = false;
    }
    // The canonical active-name index is the expected recoverable conflict. It is
    // essential to roll back stock and claim-ledger mutations before returning 409.
    if (error?.code === '23505') {
      throw new HostDownloadClaimError(409, 'DOWNLOAD_NAME_CONFLICT', 'A file with this name already exists in Downloads. Move or rename the existing item before claiming this one.');
    }
    throw error;
  } finally {
    client.release();
  }
}

module.exports = {
  HostDownloadClaimError,
  assertHostSlug,
  assertHostItemId,
  normaliseHostStock,
  publicHostStockItem,
  claimHostDownload
};
