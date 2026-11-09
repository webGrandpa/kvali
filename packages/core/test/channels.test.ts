import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  PushSender,
  channelNames,
  discordBody,
  discordCheck,
  normalizePhoneConfig,
  readPhoneConfig,
  telegramBot,
  telegramFindChat,
  telegramPairCode,
  telegramStartLink,
  telegramText,
  writePhoneConfig,
  type PhoneConfig,
  type PhonePush,
} from '../src/phone.ts';
import { tmpHome } from './helpers.ts';

const TOKEN = '123456789:AAFabcdefghijklmnopqrstuvwxyz0123456';
const WEBHOOK = 'https://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz-ABCDEFGHIJ_0123456789';

type Call = { url: string; method: string; body?: any };
function fakeFetch(answer: (c: Call) => { status?: number; json?: unknown; text?: string } = () => ({})) {
  const calls: Call[] = [];
  let n = 100;
  const impl = (async (url: string | URL, init?: RequestInit) => {
    const c: Call = { url: String(url), method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(c);
    const a = answer(c);
    const status = a.status ?? 200;
    const json =
      a.json ??
      (c.url.includes('api.telegram.org') ? { ok: true, result: { message_id: ++n } } : c.url.includes('discord.com') ? { id: `m${++n}` } : {});
    const text = a.text ?? JSON.stringify(json);
    return { ok: status < 300, status, json: async () => JSON.parse(text), text: async () => text } as Response;
  }) as typeof fetch;
  return { impl, calls };
}

const push = (over: Partial<PhonePush> = {}): PhonePush => ({ event: 'steps', title: 'Claude Code · shop · 1/4', message: '███░░░░░░░ 25%\nNow: <Step 2>', priority: 2, tags: ['arrow_forward'], ...over });

test('phone setup: Telegram or Discord alone is a setup; bad tokens and webhooks are ignored; nothing else is lost', async () => {
  const tg = normalizePhoneConfig({ v: 3, telegram: { token: TOKEN, chatId: 42, bot: 'kvali_goga_bot' } });
  assert.deepEqual(tg?.telegram, { token: TOKEN, chatId: '42', bot: 'kvali_goga_bot' });
  assert.equal(tg?.topic, undefined);
  assert.equal(normalizePhoneConfig({ telegram: { token: 'nope', chatId: 42 } }), undefined);
  assert.equal(normalizePhoneConfig({ discord: { webhook: 'https://evil.example.com/api/webhooks/1/x' } }), undefined);
  const both = normalizePhoneConfig({ topic: 'kvali-abc', discord: { webhook: WEBHOOK } });
  assert.equal(channelNames(both!), 'ntfy, Discord');

  const home = tmpHome();
  const cfg: PhoneConfig = { server: 'https://ntfy.sh', telegram: { token: TOKEN, chatId: '42' }, discord: { webhook: WEBHOOK }, events: ['done'], details: true };
  await writePhoneConfig(home, cfg);
  const back = await readPhoneConfig(home);
  assert.deepEqual([back?.topic, back?.telegram?.chatId, back?.discord?.webhook, back?.events], [undefined, '42', WEBHOOK, ['done']]);
});

test('PushSender: every channel gets the push; a task keeps one message, edited silently and replaced by its end', async () => {
  const f = fakeFetch();
  const sender = new PushSender(f.impl);
  const cfg: PhoneConfig = { server: 'https://ntfy.sh', topic: 'kvali-abc', telegram: { token: TOKEN, chatId: '42' }, discord: { webhook: WEBHOOK }, events: [], details: true };
  assert.deepEqual(await sender.send(cfg, push({ sequence: 'kvali-s1-a' })), { ok: true });
  assert.deepEqual(
    f.calls.map((c) => [c.method, c.url.replace(TOKEN, '<token>').replace(WEBHOOK, '<webhook>')]),
    [
      ['POST', 'https://ntfy.sh'],
      ['POST', 'https://api.telegram.org/bot<token>/sendMessage'],
      ['POST', '<webhook>?wait=true'],
    ],
  );
  const [, tgSend, dcSend] = f.calls;
  assert.equal(tgSend!.body.text, '▶️ <b>Claude Code · shop · 1/4</b>\n███░░░░░░░ 25%\nNow: &lt;Step 2&gt;');
  assert.equal(tgSend!.body.disable_notification, true, 'progress is silent');
  assert.equal(dcSend!.body.flags, 4_096, 'silent on Discord too');
  assert.deepEqual(dcSend!.body.allowed_mentions, { parse: [] });

  // The next update edits the same messages.
  f.calls.length = 0;
  await sender.send(cfg, push({ sequence: 'kvali-s1-a', title: 'Claude Code · shop · 2/4' }));
  assert.deepEqual(
    f.calls.slice(1).map((c) => [c.method, c.url.replace(TOKEN, '<token>').replace(WEBHOOK, '<webhook>'), c.body?.message_id]),
    [
      ['POST', 'https://api.telegram.org/bot<token>/editMessageText', 101],
      ['PATCH', '<webhook>/messages/m102', undefined],
    ],
  );
  assert.equal(f.calls[2]!.body.flags, undefined, 'an edit sends no flags');

  // The task's end replaces them with a new message, which notifies.
  f.calls.length = 0;
  await sender.send(cfg, push({ sequence: 'kvali-s1-a', event: 'done', title: 'Claude Code finished · shop', message: 'Done in 12m', priority: 3, tags: ['white_check_mark'] }));
  assert.deepEqual(
    f.calls.slice(1).map((c) => [c.method, c.url.replace(TOKEN, '<token>').replace(WEBHOOK, '<webhook>')]),
    [
      ['POST', 'https://api.telegram.org/bot<token>/deleteMessage'],
      ['POST', 'https://api.telegram.org/bot<token>/sendMessage'],
      ['DELETE', '<webhook>/messages/m102'],
      ['POST', '<webhook>?wait=true'],
    ],
  );
  assert.equal(f.calls[2]!.body.disable_notification, false);
  assert.equal(f.calls[4]!.body.embeds[0].color, 0x3fb950);
  assert.equal(f.calls[4]!.body.embeds[0].title, '✅ Claude Code finished · shop');
});

test('PushSender: a failing channel is named, by host only, and the others still get the push', async () => {
  const f = fakeFetch((c) => (c.url.includes('telegram') ? { status: 401, text: '{"ok":false,"description":"Unauthorized"}' } : {}));
  const r = await new PushSender(f.impl).send({ server: 'https://ntfy.sh', topic: 'kvali-abc', telegram: { token: TOKEN, chatId: '42' }, events: [], details: true }, push());
  assert.equal(r.ok, false);
  assert.match(!r.ok ? r.error : '', /^api\.telegram\.org answered 401/);
  assert.doesNotMatch(JSON.stringify(r), /AAF/, 'the token never appears in an error');
  assert.equal(f.calls.length, 2);
});

test('Telegram setup: the token names the bot, and only a message with the code names the chat', async () => {
  const code = telegramPairCode();
  assert.match(code, /^\d{6}$/);
  assert.equal(telegramStartLink('kvali_goga_bot', code), `https://t.me/kvali_goga_bot?start=${code}`);
  const f = fakeFetch((c) => {
    if (c.url.endsWith('/getMe')) return { json: { ok: true, result: { username: 'kvali_goga_bot' } } };
    if (c.url.includes('getUpdates') && !c.url.includes('offset'))
      return {
        json: {
          ok: true,
          result: [
            // Anyone may find a bot and write to it: a stranger's message, before and while Kvali waits.
            { update_id: 5, message: { text: 'hi', chat: { id: 666, type: 'private', first_name: 'Stranger' } } },
            { update_id: 6, message: { text: `/start ${code}`, chat: { id: 777, type: 'group', title: 'A group' } } },
            { update_id: 7, message: { text: `/start ${code}`, chat: { id: 4242, type: 'private', first_name: 'Goga', username: 'goga' } } },
            { update_id: 8, message: { text: 'later', chat: { id: 666, type: 'private' } } },
          ],
        },
      };
    return { json: { ok: true, result: [] } };
  });
  assert.deepEqual(await telegramBot(TOKEN, f.impl), { ok: true, username: 'kvali_goga_bot' });
  assert.deepEqual(await telegramBot('123:bad', f.impl), { ok: false, error: 'that is not a bot token (it looks like 123456789:AAF…)' });
  assert.deepEqual(await telegramFindChat(TOKEN, code, 5_000, f.impl), { id: '4242', name: 'Goga (@goga)' });
  assert.match(f.calls.at(-1)!.url, /getUpdates\?timeout=0&offset=9$/, 'the messages read are acknowledged');
  const strangers = fakeFetch(() => ({ json: { ok: true, result: [{ update_id: 1, message: { text: 'hello 12345678', chat: { id: 666, type: 'private' } } }] } }));
  assert.equal(await telegramFindChat(TOKEN, code, 1_200, strangers.impl), undefined, 'no code, no chat');
  assert.equal(await telegramFindChat(TOKEN, '1.*', 1_200, f.impl), undefined, 'a code is six digits');
});

test('Discord setup checks the webhook; message bodies stay within Discord\'s limits', async () => {
  const ok = fakeFetch(() => ({ json: { name: 'Kvali', channel_id: '1' } }));
  assert.deepEqual(await discordCheck(WEBHOOK, ok.impl), { ok: true, name: 'Kvali' });
  const gone = fakeFetch(() => ({ status: 404, text: '{"message":"Unknown Webhook"}' }));
  assert.deepEqual(await discordCheck(WEBHOOK, gone.impl), { ok: false, error: 'Discord does not know this webhook' });
  assert.equal((await discordCheck('https://example.com/hook', ok.impl)).ok, false);
  const long = discordBody(push({ title: 'x'.repeat(400), message: 'y'.repeat(5_000) })) as { embeds: { title: string; description: string }[] };
  assert.equal(long.embeds[0]!.title.length, 256);
  assert.equal(long.embeds[0]!.description.length, 4_000);
  assert.equal(telegramText(push({ tags: [], message: '' })), '<b>Claude Code · shop · 1/4</b>');
});
