// Transaction lock — prevents duplicate buys/sells for the same mint/position
const locks = new Map(); // key → { acquiredAt, type, timeoutId }
const TX_TIMEOUT_MS = Number(process.env.TX_TIMEOUT_MS) || 30_000;

export function acquireLock(key, type = 'sell') {
  if (locks.has(key)) return false;
  const timeoutId = setTimeout(() => {
    if (locks.has(key)) {
      console.warn(`[txLock] lock expired for ${key} (${type}) after ${TX_TIMEOUT_MS}ms`);
      locks.delete(key);
    }
  }, TX_TIMEOUT_MS);
  locks.set(key, { acquiredAt: Date.now(), type, timeoutId });
  return true;
}

export function releaseLock(key) {
  const entry = locks.get(key);
  if (entry) {
    clearTimeout(entry.timeoutId);
    locks.delete(key);
  }
}

export function isLocked(key) {
  return locks.has(key);
}

export function getPendingTxs() {
  const now = Date.now();
  return [...locks.entries()].map(([key, v]) => ({
    key,
    type: v.type,
    ageMs: now - v.acquiredAt,
  }));
}
