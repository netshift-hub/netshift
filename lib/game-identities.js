'use strict';

const crypto = require('node:crypto');

/**
 * Generate a fictional, private-range IPv4 address for a NETSHIFT workstation.
 *
 * Addresses are drawn from RFC1918's 172.16.0.0/12 block and are never based on
 * the player's real IP. The third and fourth octets deliberately have opposite
 * digit lengths (one 2-digit, one 3-digit), producing addresses such as
 * 172.19.42.187 while keeping the address safely non-routable on the public internet.
 */
function generateGameIp() {
  const second = crypto.randomInt(16, 32); // 172.16.0.0/12 private range
  const thirdIsTwoDigit = crypto.randomInt(0, 2) === 0;
  const third = thirdIsTwoDigit
    ? crypto.randomInt(10, 100)
    : crypto.randomInt(100, 255);
  const fourth = thirdIsTwoDigit
    ? crypto.randomInt(100, 255)
    : crypto.randomInt(10, 100);
  return `172.${second}.${third}.${fourth}`;
}

/** Eight-digit fictional bank account number, allocated randomly rather than sequentially. */
function generateBankAccountNumber() {
  return String(crypto.randomInt(10_000_000, 100_000_000));
}

/** The legacy v2 preview derived 12-digit account numbers deterministically from user IDs. */
function legacyDeterministicAccountNumber(userId) {
  return `10${String(userId).padStart(10, '0')}`;
}

function hasGameIpShape(value) {
  if (typeof value !== 'string') return false;
  const octets = value.split('.');
  if (octets.length !== 4 || octets.some(part => !/^\d{2,3}$/.test(part))) return false;
  const numbers = octets.map(Number);
  if (numbers.some(value => value < 10 || value > 254)) return false;
  if (numbers[0] !== 172 || numbers[1] < 16 || numbers[1] > 31) return false;
  // For the last two octets, require one 2-digit and one 3-digit value.
  return (octets[2].length === 2 && octets[3].length === 3)
    || (octets[2].length === 3 && octets[3].length === 2);
}

function hasRandomBankNumberShape(value) {
  return typeof value === 'string' && /^\d{8}$/.test(value) && value[0] !== '0';
}

module.exports = {
  generateGameIp,
  generateBankAccountNumber,
  legacyDeterministicAccountNumber,
  hasGameIpShape,
  hasRandomBankNumberShape
};
