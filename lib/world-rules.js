'use strict';

// Server-owned intrusion probabilities. Client input must never determine the outcome.
function worldBreachChance(securityLevel, isContested = false) {
  const level = Math.max(0, Math.min(5, Number.isFinite(Number(securityLevel)) ? Math.trunc(Number(securityLevel)) : 0));
  const baseChance = Math.max(10, 90 - (level * 13));
  return Math.max(10, baseChance - (isContested ? 15 : 0));
}

module.exports = { worldBreachChance };
