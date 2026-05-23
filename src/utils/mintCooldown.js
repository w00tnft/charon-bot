const cooldowns = new Map();
const COOLDOWN_MS = Number(process.env.LOSS_COOLDOWN_MS) || 7_200_000;

export function recordLoss(mint) {
  cooldowns.set(mint, Date.now());
  console.log(`[cooldown] ${mint.slice(0, 8)} on cooldown for ${Math.round(COOLDOWN_MS / 3_600_000)}h after loss`);
}

export function isOnCooldown(mint) {
  const lossTime = cooldowns.get(mint);
  if (!lossTime) return false;
  if (Date.now() - lossTime > COOLDOWN_MS) {
    cooldowns.delete(mint);
    return false;
  }
  return true;
}
