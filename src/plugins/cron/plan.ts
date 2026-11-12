import { CronExpressionParser } from 'cron-parser';
import { assert } from '../../core/errors.js';

export const DEFAULT_TIMEZONE = 'Asia/Shanghai';
export const MINUTE_MS = 60_000;
const MAX_INTERVAL = 5_256_000; // 最多十年，避免生成无效的绝对时间。
export type Schedule = { kind: 'cron'; expression: string; timezone: string } | { kind: 'interval'; minutes: number };

export function object(value: unknown): Record<string, unknown> {
  assert(value && typeof value === 'object' && !Array.isArray(value), 'INVALID_CRON_CONFIG', '预期对象', undefined);
  return value as Record<string, unknown>;
}

export function scheduleOf(value: unknown): Schedule {
  const input = object(value);
  if (input.kind === 'interval') {
    const minutes = Number(input.minutes);
    assert((typeof input.minutes === 'number' || typeof input.minutes === 'string' && input.minutes.trim()) && Number.isSafeInteger(minutes) && minutes >= 1 && minutes <= MAX_INTERVAL, 'INVALID_CRON_CONFIG', '间隔必须为有效的正整数分钟');
    return { kind: 'interval', minutes };
  }
  assert(input.kind === 'cron' && typeof input.expression === 'string', 'INVALID_CRON_CONFIG', '需要 cron 或 interval 周期');
  const expression = input.expression.trim().replace(/\s+/g, ' ');
  const timezone = input.timezone ?? DEFAULT_TIMEZONE;
  const withoutNames = expression.replace(/JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC|SUN|MON|TUE|WED|THU|FRI|SAT/gi, '1');
  assert(typeof timezone === 'string' && expression.split(' ').length === 5 && /^[\d *,/-]+$/.test(withoutNames), 'INVALID_CRON_CONFIG', '需要五字段 cron 表达式与有效时区');
  try {
    new Intl.DateTimeFormat('en', { timeZone: timezone });
    CronExpressionParser.parse(expression, { tz: timezone }).next();
  } catch { assert(false, 'INVALID_CRON_CONFIG', 'cron 表达式、时区或下一次触发时间无效'); }
  return { kind: 'cron', expression, timezone };
}

export function nextSlot(schedule: Schedule, now: number): number {
  if (schedule.kind === 'interval') return now + schedule.minutes * MINUTE_MS;
  return CronExpressionParser.parse(schedule.expression, { tz: schedule.timezone, currentDate: new Date(now) }).next().getTime();
}

export function latestSlot(schedule: Schedule, first: number, now: number): number {
  if (schedule.kind === 'interval') return first + Math.floor((now - first) / (schedule.minutes * MINUTE_MS)) * schedule.minutes * MINUTE_MS;
  const previous = CronExpressionParser.parse(schedule.expression, { tz: schedule.timezone, currentDate: new Date(now + 1) }).prev().getTime();
  return Math.max(first, previous);
}
