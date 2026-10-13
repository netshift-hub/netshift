'use strict';

const assert = require('node:assert/strict');
const {
  generateGameIp,
  generateBankAccountNumber,
  legacyDeterministicAccountNumber,
  hasGameIpShape,
  hasRandomBankNumberShape
} = require('../lib/game-identities');

const generatedIps = Array.from({ length: 200 }, generateGameIp);
assert.ok(generatedIps.every(hasGameIpShape), 'Every simulated IP must look like an IPv4 address with 2- and 3-digit octets in the private game range.');
assert.ok(generatedIps.every(ip => ip.startsWith('172.')), 'Game IPs must remain in the non-public 172.16/12 range.');

const accountNumbers = Array.from({ length: 500 }, generateBankAccountNumber);
assert.ok(accountNumbers.every(hasRandomBankNumberShape), 'Player bank numbers must be eight-digit numeric strings.');
assert.ok(new Set(accountNumbers).size > 495, 'Random bank-number generator is unexpectedly repeating values.');
assert.equal(legacyDeterministicAccountNumber(1), '100000000001', 'Legacy number detector must match the old deterministic format.');

console.log('Game identity checks OK (fictional IPv4 format, private address range, random 8-digit bank numbers).');
