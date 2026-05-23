const ALLOWED_HOURS_UTC = (process.env.TRADING_HOURS_UTC || '10,11,16,18,19')
  .split(',')
  .map(h => parseInt(h.trim(), 10));

export function isWithinTradingHours() {
  const hour = new Date().getUTCHours();
  return ALLOWED_HOURS_UTC.includes(hour);
}

export function getNextTradingWindow() {
  const hour = new Date().getUTCHours();
  const next = ALLOWED_HOURS_UTC.find(h => h > hour) ?? ALLOWED_HOURS_UTC[0];
  const hoursUntil = next > hour ? next - hour : 24 - hour + next;
  return { nextHour: next, hoursUntil };
}
