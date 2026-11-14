import type { PlanMeter } from './types';

/** "Weekly limit", "5-hour limit": a plan window named by its length. */
export function windowName(m: PlanMeter, t: (key: string) => string): string {
  if (m.minutes === 10080) return t('Weekly limit');
  if (m.minutes === 1440) return t('Daily limit');
  if (m.minutes % 1440 === 0) return t('{n}-day limit').replace('{n}', String(m.minutes / 1440));
  if (m.minutes % 60 === 0) return t('{n}-hour limit').replace('{n}', String(m.minutes / 60));
  return t('{n}-minute limit').replace('{n}', String(m.minutes));
}

/** When a window starts over: "resets in 25 min", "resets in 3 h 20 min", "resets in 6 days". */
export function resetIn(at: number | undefined, t: (key: string) => string, now = Date.now()): string {
  if (!at) return '';
  const min = Math.max(0, Math.round((at - now) / 60000));
  if (min < 60) return t('resets in {n} min').replace('{n}', String(min));
  const hours = Math.floor(min / 60);
  if (hours < 48) {
    const rest = min % 60;
    return rest ? t('resets in {h} h {m} min').replace('{h}', String(hours)).replace('{m}', String(rest)) : t('resets in {n} h').replace('{n}', String(hours));
  }
  return t('resets in {n} days').replace('{n}', String(Math.round(hours / 24)));
}
