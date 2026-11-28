import assert from 'node:assert/strict';
import { test } from 'node:test';
import { limitStopOf, parseResetsAt } from '../src/util/limit-stop.ts';

const at = Date.parse('2026-11-27T14:20:00.000Z'); // 18:20 in Tbilisi, a Friday

test('Reset times in the words Claude Code uses, in the zone it names', () => {
  assert.equal(parseResetsAt("You've hit your 5-hour limit · resets 7pm (Asia/Tbilisi)", at), Date.parse('2026-11-27T15:00:00.000Z'));
  assert.equal(parseResetsAt("You've hit your 5-hour limit · resets 7:30pm (Asia/Tbilisi)", at), Date.parse('2026-11-27T15:30:00.000Z'));
  // Earlier in the day than now: tomorrow.
  assert.equal(parseResetsAt("You've hit your 5-hour limit · resets 9am (Asia/Tbilisi)", at), Date.parse('2026-11-28T05:00:00.000Z'));
  assert.equal(parseResetsAt("You've hit your weekly limit · resets Dec 2, 9am (Asia/Tbilisi)", at), Date.parse('2026-12-02T05:00:00.000Z'));
  assert.equal(parseResetsAt("You've hit your weekly limit · resets Tue 10am (Asia/Tbilisi)", at), Date.parse('2026-12-01T06:00:00.000Z'));
  assert.equal(parseResetsAt("You've hit your 5-hour limit · resets 7pm (Europe/Berlin)", at), Date.parse('2026-11-27T18:00:00.000Z'));
  assert.equal(parseResetsAt('Your limit resets in 2h 15m', at), at + 135 * 60_000);
  assert.equal(parseResetsAt('Claude AI usage limit reached|1796000000', at), 1_796_000_000_000);
  assert.equal(parseResetsAt("You've hit your 5-hour limit", at), undefined);
  assert.equal(parseResetsAt('resets 25pm (Asia/Tbilisi)', at), undefined);
});

test('Which API error messages are a plan limit', () => {
  assert.equal(limitStopOf({ isApiErrorMessage: true }, "You've hit your 5-hour limit · resets 7pm (Asia/Tbilisi)", at)?.limit, '5-hour limit');
  assert.equal(limitStopOf({ isApiErrorMessage: true }, "You've hit your weekly limit · resets Dec 2, 9am · progress saved", at)?.limit, 'weekly limit');
  assert.equal(limitStopOf({ isApiErrorMessage: true }, "You've reached your Fable limit.", at)?.limit, 'Fable limit');
  assert.equal(limitStopOf({ apiError: 'usage_limit_reached', apiErrorParams: { rate_limit_info: { rateLimitType: 'seven_day_opus' } } }, 'Limit reached', at)?.limit, 'Opus limit');
  assert.equal(limitStopOf({ isApiErrorMessage: true }, 'Claude AI usage limit reached|1796000000', at)?.resetsAt, 1_796_000_000_000);
  assert.equal(limitStopOf({ isApiErrorMessage: true }, 'API Error: 500 Internal server error', at), undefined);
  assert.equal(limitStopOf({ error: 'rate_limit' }, 'API Error: rate limited — wait and retry', at), undefined, 'a short rate limit is not a plan limit');
});
