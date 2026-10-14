'use strict';

const {
  EconomyLedgerError,
  validateIdempotencyKey,
  ensureMoneyLedgerBaseline,
  createMoneyTransaction
} = require('./economy-ledger');

class BankTransferError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'BankTransferError';
    this.status = status;
    this.code = code;
  }
}

function parseTransferAmountCents(value) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new BankTransferError(400, 'TRANSFER_AMOUNT_INVALID', 'Enter a valid transfer amount.');
    value = String(value);
  }
  if (typeof value !== 'string') throw new BankTransferError(400, 'TRANSFER_AMOUNT_INVALID', 'Enter a valid transfer amount.');
  const trimmed = value.trim();
  // Decimal notation only: no signs, exponents, commas, or fractions of a cent.
  if (!/^\d{1,8}(?:\.\d{1,2})?$/.test(trimmed)) {
    throw new BankTransferError(400, 'TRANSFER_AMOUNT_INVALID', 'Enter an amount between $0.01 and $99,999,999.99 with no more than two decimal places.');
  }
  const [whole, fractional = ''] = trimmed.split('.');
  const cents = Number(whole) * 100 + Number((fractional + '00').slice(0, 2));
  if (!Number.isSafeInteger(cents) || cents < 1) {
    throw new BankTransferError(400, 'TRANSFER_AMOUNT_INVALID', 'Transfer amount must be at least $0.01.');
  }
  return cents;
}

function normaliseBankTransferRequest(input) {
  const recipientAccountNumber = typeof input?.recipientAccountNumber === 'string'
    ? input.recipientAccountNumber.trim() : '';
  if (!/^\d{8}$/.test(recipientAccountNumber)) {
    throw new BankTransferError(400, 'RECIPIENT_ACCOUNT_INVALID', 'Enter the recipient’s eight-digit First Bank account number.');
  }
  const amountCents = parseTransferAmountCents(input?.amount);
  const reference = typeof input?.reference === 'string' ? input.reference.trim() : '';
  if (reference.length > 80 || /[\u0000-\u001f\u007f]/.test(reference)) {
    throw new BankTransferError(400, 'TRANSFER_REFERENCE_INVALID', 'The transfer reference must be 80 characters or fewer and contain no control characters.');
  }
  const idempotencyKey = typeof input?.idempotencyKey === 'string' ? input.idempotencyKey.trim() : '';
  if (!validateIdempotencyKey(idempotencyKey) || idempotencyKey.length > 80) {
    throw new BankTransferError(400, 'TRANSFER_IDEMPOTENCY_KEY_INVALID', 'A valid transfer request key is required.');
  }
  return { recipientAccountNumber, amountCents, reference, idempotencyKey };
}

/**
 * Atomically transfer money between two active player First Bank accounts.
 * The caller must enforce NETSHIFT session ownership and bank-session authentication.
 * This function manages its own DB transaction; caller owns/release the client.
 */
async function transferFirstBankFunds(client, { senderUserId, recipientAccountNumber, amountCents, reference = '', idempotencyKey }) {
  if (!/^\d+$/.test(String(senderUserId ?? ''))) throw new BankTransferError(401, 'BANK_SENDER_INVALID', 'The sender account could not be verified.');
  if (!/^\d{8}$/.test(String(recipientAccountNumber ?? ''))) throw new BankTransferError(400, 'RECIPIENT_ACCOUNT_INVALID', 'Enter the recipient’s eight-digit First Bank account number.');
  if (!Number.isSafeInteger(Number(amountCents)) || Number(amountCents) < 1) throw new BankTransferError(400, 'TRANSFER_AMOUNT_INVALID', 'Transfer amount must be at least $0.01.');
  if (typeof reference !== 'string' || reference.length > 80 || /[\u0000-\u001f\u007f]/.test(reference)) throw new BankTransferError(400, 'TRANSFER_REFERENCE_INVALID', 'The transfer reference is invalid.');
  if (!validateIdempotencyKey(idempotencyKey) || idempotencyKey.length > 80) throw new BankTransferError(400, 'TRANSFER_IDEMPOTENCY_KEY_INVALID', 'A valid transfer request key is required.');

  let transactionOpen = false;
  try {
    await client.query('BEGIN');
    transactionOpen = true;

    // Lock sender and recipient in one globally consistent account-ID order. The
    // account-number lookup and all balance checks therefore occur inside the lock.
    const locked = await client.query(`SELECT id, owner_user_id, bank_code, account_number,
        account_username, password_hash, balance_cents, is_player
      FROM netshift_bank_accounts
      WHERE owner_user_id=$1 OR account_number=$2
      ORDER BY id FOR UPDATE`, [String(senderUserId), recipientAccountNumber]);
    const sender = locked.rows.find(row => String(row.owner_user_id) === String(senderUserId));
    const recipient = locked.rows.find(row => String(row.account_number) === recipientAccountNumber);

    if (!sender || !sender.is_player || !sender.password_hash) {
      throw new BankTransferError(409, 'BANK_SETUP_REQUIRED', 'Complete First Bank setup before sending money.');
    }
    if (!recipient || !recipient.is_player || !recipient.password_hash || recipient.owner_user_id == null) {
      throw new BankTransferError(404, 'RECIPIENT_ACCOUNT_UNAVAILABLE', 'That First Bank account is unavailable for transfers.');
    }
    if (String(sender.id) === String(recipient.id) || String(sender.owner_user_id) === String(recipient.owner_user_id)) {
      throw new BankTransferError(400, 'SELF_TRANSFER_NOT_ALLOWED', 'You cannot transfer money to your own First Bank account.');
    }

    // Establish a one-time journal baseline for any pre-E2 balance. It records but
    // does not alter the persisted balance; rollback keeps it atomic with the transfer.
    await ensureMoneyLedgerBaseline(client, sender);
    await ensureMoneyLedgerBaseline(client, recipient);

    const scopedIdempotencyKey = `bank-transfer:${senderUserId}:${idempotencyKey}`;
    const transfer = await createMoneyTransaction(client, {
      idempotencyKey: scopedIdempotencyKey,
      transactionType: 'player_transfer',
      actorUserId: String(senderUserId),
      metadata: {
        currency: 'USD',
        senderBankAccountId: String(sender.id),
        recipientBankAccountId: String(recipient.id),
        senderAccountNumber: String(sender.account_number),
        recipientAccountNumber: String(recipient.account_number),
        reference
      },
      postings: [
        { bankAccountId: String(sender.id), accountOwnerUserId: String(sender.owner_user_id), amountCents: -Number(amountCents) },
        { bankAccountId: String(recipient.id), accountOwnerUserId: String(recipient.owner_user_id), amountCents: Number(amountCents) }
      ]
    });

    if (transfer.duplicate) {
      await client.query('COMMIT');
      transactionOpen = false;
      return {
        transactionId: transfer.id, duplicate: true,
        senderBalanceCents: Number(sender.balance_cents), recipientBalanceCents: Number(recipient.balance_cents),
        recipientAccountNumber: String(recipient.account_number)
      };
    }

    if (Number(sender.balance_cents) < Number(amountCents)) {
      throw new BankTransferError(409, 'INSUFFICIENT_FUNDS', 'There are insufficient funds for this transfer.');
    }

    const debited = await client.query(`UPDATE netshift_bank_accounts
      SET balance_cents=balance_cents-$2
      WHERE id=$1 AND balance_cents >= $2
      RETURNING balance_cents`, [sender.id, Number(amountCents)]);
    if (!debited.rowCount) throw new BankTransferError(409, 'INSUFFICIENT_FUNDS', 'There are insufficient funds for this transfer.');

    const credited = await client.query(`UPDATE netshift_bank_accounts
      SET balance_cents=balance_cents+$2
      WHERE id=$1
      RETURNING balance_cents`, [recipient.id, Number(amountCents)]);
    if (!credited.rowCount) throw new BankTransferError(409, 'RECIPIENT_ACCOUNT_UNAVAILABLE', 'The recipient account is no longer available.');

    await client.query('COMMIT');
    transactionOpen = false;
    return {
      transactionId: transfer.id, duplicate: false,
      senderBalanceCents: Number(debited.rows[0].balance_cents),
      recipientBalanceCents: Number(credited.rows[0].balance_cents),
      recipientAccountNumber: String(recipient.account_number)
    };
  } catch (error) {
    if (transactionOpen) {
      try { await client.query('ROLLBACK'); } catch (_) { /* preserve originating error */ }
    }
    if (error instanceof EconomyLedgerError) throw error;
    throw error;
  }
}

module.exports = {
  BankTransferError,
  parseTransferAmountCents,
  normaliseBankTransferRequest,
  transferFirstBankFunds
};
