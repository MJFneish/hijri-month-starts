#!/usr/bin/env node
// Refreshes month-starts.json from each marjaa office's own announcements. Run by
// .github/workflows/update.yml: every 30 minutes on evenings (when crescent decisions come out)
// and twice each morning (date headers, Fadlallah's calendar). Zero dependencies; Node 20+.
//
// A finding never silently replaces a different date already in the feed: the run exits 1 so
// GitHub emails the repo owner, who fixes month-starts.json by hand (the only exception is
// Fadlallah's office calendar, which is the office's own calculation and may be revised).

import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const FEED = new URL('./month-starts.json', import.meta.url);
const BROWSER_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const NOW = new Date();
/** Date headers flip at midnight; only read them in daytime in Najaf/Beirut (08:00-16:59 local). */
const DAYTIME = NOW.getUTCHours() >= 5 && NOW.getUTCHours() <= 13;
const problems = [];

// ---------- helpers ----------

const pad = (n) => String(n).padStart(2, '0');
const isoDate = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;
const addDays = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
const monthKey = (year, month) => `${year}-${pad(month)}`;
const shiftKey = (key, delta) => {
  const [y, m] = key.split('-').map(Number);
  const index = y * 12 + m - 1 + delta;
  return monthKey(Math.floor(index / 12), (index % 12) + 1);
};
const beirutDate = (instant) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Beirut', year: 'numeric', month: '2-digit', day: '2-digit' }).format(
    new Date(instant)
  );

/** Western digits, no diacritics/tatweel, one form of alef/yeh/teh marbuta, single spaces. */
function normalize(text) {
  return text
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x6f0))
    .replace(/[ً-ْٰـ]/g, '')
    .replace(/[أإآ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const stripTags = (html) => html.replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, ' ');

/** Month number from a (normalized) Arabic month name, two-word names first. */
function arabicMonth(name) {
  const table = [
    [/ربيع (الاول)/, 3],
    [/ربيع (الثاني|الاخر)/, 4],
    [/جمادي (الاولي|الاول)/, 5],
    [/جمادي (الثانيه|الاخره|الاخر)/, 6],
    [/(ذو|ذي) القعده/, 11],
    [/(ذو|ذي) الحجه/, 12],
    [/محرم/, 1],
    [/صفر/, 2],
    [/رجب/, 7],
    [/شعبان/, 8],
    [/رمضان/, 9],
    [/شوال/, 10],
  ];
  return table.find(([pattern]) => pattern.test(name))?.[1] ?? null;
}

async function get(url, init = {}) {
  const response = await fetch(url, { ...init, headers: { 'User-Agent': BROWSER_UA, ...init.headers }, signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`${url} -> HTTP ${response.status}`);
  return response;
}

/** Public channel preview (t.me/s/...) → [{ id, at, text, photos }]. */
async function telegramPosts(channel, query) {
  const html = await (await get(`https://t.me/s/${channel}?q=${encodeURIComponent(query)}`)).text();
  return html
    .split('<div class="tgme_widget_message_wrap')
    .slice(1)
    .map((chunk) => ({
      id: chunk.match(/data-post="([^"]+)"/)?.[1],
      at: chunk.match(/datetime="([^"]+)"/)?.[1],
      text: stripTags(chunk.match(/tgme_widget_message_text[^>]*>([\s\S]*?)<\/div>/)?.[1] ?? ''),
      photos: [...chunk.matchAll(/tgme_widget_message_photo_wrap[^>]*background-image:url\('([^']+)'\)/g)].map((m) => m[1]),
    }))
    .filter((post) => post.id && post.at);
}

async function ocrArabic(url) {
  const dir = await mkdtemp(join(tmpdir(), 'ocr-'));
  try {
    const file = join(dir, 'image');
    await writeFile(file, Buffer.from(await (await get(url)).arrayBuffer()));
    const { stdout } = await promisify(execFile)('tesseract', [file, 'stdout', '-l', 'ara'], { maxBuffer: 1 << 20 });
    return stdout;
  } catch (error) {
    console.warn(`OCR failed for ${url}: ${error.message}`);
    return '';
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ---------- sources ----------

const BAYYNAT_MONTHS = {
  Muharram: 1, Safar: 2, 'Rabih Awwal': 3, 'Rabih Thani': 4, 'Jumada Oula': 5, 'Jumada Akhira': 6,
  Rajab: 7, Shaaban: 8, Ramadan: 9, Shawwal: 10, "Thu LQo'da": 11, 'Thu LHujja': 12,
};

/** Fadlallah: the office's calendar service on bayynat.org.lb (what its prayer-times page uses).
 * The office decides by calculation and publishes it ahead, so this covers the coming year. */
async function fadlallahCalendar() {
  const from = addDays(beirutDate(NOW), -60).replace(/-/g, '/');
  const to = addDays(beirutDate(NOW), 420).replace(/-/g, '/');
  const body = new URLSearchParams({
    miladiDate: `${from} - ${to}`, rangeType: 'custom', calendarType: 'Gregorian', countryCode: 'LB',
    latitude: '33.89', longitude: '35.5', elevation: '0', timeZoneString: 'Asia/Beirut', LangString: 'en',
    toHijriDate: '', fromHijriDate: '',
  });
  const json = await (
    await get('https://www.bayynat.org.lb/webservices/MawakitAlSalatWebService.ashx?action=CallAllFunctionsAsync', { method: 'POST', body })
  ).json();
  const rows = [...String(json.data ?? '').matchAll(/text-content">(\d{4}-\d{2}-\d{2})<\/div>\s*<div class="text-content"[^>]*>(\d+) ([^<]+?) (\d{4})<\/div>/g)];
  if (rows.length < 300) throw new Error(`bayynat calendar: only ${rows.length} days parsed`);
  return rows
    .filter(([, , day, name]) => day === '1' && BAYYNAT_MONTHS[name])
    .map(([, date, , name, year]) => ({ key: monthKey(Number(year), BAYYNAT_MONTHS[name]), date, source: 'bayynat.org.lb calendar' }));
}

/** Sistani: today's Najaf Hijri date in sistani.org's header, e.g. «الثلاثاء ٨- جمادى الأولى -١٤٤٨ هـ ... Tue, 20 Oct 2026». */
async function sistaniHeader() {
  const html = await (await get('https://www.sistani.org/', { headers: { 'User-Agent': 'okhttp/4.12.0' } })).text();
  const block = normalize(stripTags(html.match(/<div id="home-date">([\s\S]*?)<\/div>/)?.[1] ?? ''));
  const hijri = block.match(/(\d{1,2})\s*-\s*(.+?)\s*-\s*(\d{4})\s*ه/);
  const greg = block.match(/(\d{1,2}) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\w* (\d{4})/);
  const month = hijri && arabicMonth(hijri[2]);
  if (!hijri || !greg || !month) throw new Error(`sistani.org header not understood: "${block}"`);
  const today = isoDate(Number(greg[3]), 'JanFebMarAprMayJunJulAugSepOctNovDec'.indexOf(greg[2]) / 3 + 1, Number(greg[1]));
  return [{ key: monthKey(Number(hijri[3]), month), date: addDays(today, 1 - Number(hijri[1])), source: 'sistani.org header' }];
}

/** Sistani: the office's statement as posted by the Imam Hussain shrine, e.g. «... ويوم الثلاثاء
 * الموافق (١٣-١٠-٢٠٢٦م) هو الأوّل من شهر جمادى الأولى لعام ١٤٤٨ للهجرة». */
async function sistaniStatements() {
  const posts = await telegramPosts('imamhussain_ar', 'مكتب سماحة السيد السيستاني هلال');
  return posts.flatMap((post) => {
    const text = normalize(post.text);
    if (!text.includes('السيستاني')) return [];
    const m = text.match(/\((\d{1,2})-(\d{1,2})-(\d{4})\s*م?\s*\)\s*هو الاول من شهر (.+?) لعام (\d{4})/);
    const month = m && arabicMonth(m[4]);
    if (!m || !month) return [];
    return [{ key: monthKey(Number(m[5]), month), date: isoDate(Number(m[3]), Number(m[2]), Number(m[1])), source: `t.me/${post.id}` }];
  });
}

/** Khamenei, Lebanon office: its «استهلال شهر ...» post goes up on the evening of the 29th, with the
 * decision in an image («... لم تثبت الرؤية ... المتمم لعدة شهر ...»). The month therefore starts
 * the next day if the crescent was sighted, or the day after (30 days) if not. */
async function khameneiStatements(feed) {
  const posts = await telegramPosts('leader_lb_channel', 'استهلال');
  const findings = [];
  for (const post of posts) {
    const caption = normalize(post.text);
    const m = caption.match(/استهلال شهر (.+?) (?:لعام )?(14\d\d)/);
    const month = m && arabicMonth(m[1]);
    if (!month) continue;
    const key = monthKey(Number(m[2]), month);
    const known = feed.monthStarts.khamenei[key];
    // Already settled by an earlier statement: don't OCR it again every half hour.
    if (known && feed.sources.khamenei?.[key]?.startsWith('t.me/')) continue;
    if (daysBetween(beirutDate(post.at), beirutDate(NOW)) > 45) continue;

    let text = caption;
    for (const photo of post.photos) text += ` ${normalize(await ocrArabic(photo))}`;
    const postDate = beirutDate(post.at);
    const notSighted = /لم ?تثبت|لم ?يثبت|المتمم|متمم|اكمال/.test(text);
    const sighted = /ثبتت|ثبت الهلال|ثبوت الرؤيه|ثبوت رؤيه|غدا .{0,40}الاول من شهر/.test(text);
    if (!notSighted && !sighted) {
      console.warn(`${post.id}: decision not readable yet (caption + OCR): ${text.slice(0, 300)}`);
      continue;
    }
    const date = addDays(postDate, notSighted ? 2 : 1);
    // Cross-check: the start's day of month appears in the statement, or the post went up on the
    // evening of the 29th of the previous month as recorded in the feed.
    const previous = feed.monthStarts.khamenei[shiftKey(key, -1)];
    const dayInText = new RegExp(`(^|\\D)${Number(date.slice(8))}(\\D|$)`).test(text);
    if (!dayInText && !(previous && daysBetween(previous, postDate) === 28)) {
      console.warn(`${post.id}: ${key} = ${date} could not be cross-checked; waiting for the Al-Manar header`);
      continue;
    }
    findings.push({ key, date, source: `t.me/${post.id}` });
  }
  return findings;
}

/** Khamenei, Lebanon office, next-morning cross-check: Al-Manar's header shows the Hijri date as
 * announced in Lebanon, e.g. «الثلاثاء | 20 10 2026 | 8 جمادى الأولى 1448». */
async function khameneiHeader() {
  const html = await (await get('https://www.almanar.com.lb/')).text();
  const at = html.indexOf('top-dates');
  if (at < 0) throw new Error('almanar.com.lb: no top-dates bar');
  const block = normalize(stripTags(html.slice(at, at + 1500)));
  const m = block.match(/(\d{1,2}) (\d{1,2}) (20\d\d) (\d{1,2}) (.+?) (14\d\d)/);
  const month = m && arabicMonth(m[5]);
  if (!m || !month) throw new Error(`almanar.com.lb header not understood: "${block.slice(0, 200)}"`);
  const today = isoDate(Number(m[3]), Number(m[2]), Number(m[1]));
  return [{ key: monthKey(Number(m[6]), month), date: addDays(today, 1 - Number(m[4])), source: 'almanar.com.lb header' }];
}

// ---------- merge ----------

function merge(feed, authority, findings, { revisable = false } = {}) {
  const starts = (feed.monthStarts[authority] ??= {});
  const sources = ((feed.sources ??= {})[authority] ??= {});
  let changed = false;
  for (const { key, date, source } of findings) {
    const existing = starts[key];
    if (existing === date) {
      if (!sources[key]?.startsWith('t.me/') && source.startsWith('t.me/')) {
        sources[key] = source;
        changed = true;
      }
      continue;
    }
    // A month is 29 or 30 days: check against the neighbouring months already in the feed.
    const previous = starts[shiftKey(key, -1)];
    const next = starts[shiftKey(key, 1)];
    const badLength = [previous && daysBetween(previous, date), next && daysBetween(date, next)].find(
      (length) => length && length !== 29 && length !== 30
    );
    if (badLength) {
      problems.push(`${authority} ${key} = ${date} (${source}) would make a month ${badLength} days long`);
      continue;
    }
    if (existing && !revisable) {
      problems.push(`${authority} ${key}: feed has ${existing} (${sources[key] ?? 'seed'}), ${source} says ${date}`);
      continue;
    }
    if (existing) console.log(`${authority} ${key}: revised ${existing} -> ${date} (${source})`);
    else console.log(`${authority} ${key} = ${date} (${source})`);
    starts[key] = date;
    sources[key] = source;
    changed = true;
  }
  return changed;
}

async function attempt(label, run) {
  try {
    return await run();
  } catch (error) {
    // A source being down is normal (the next run retries); it's not worth an email.
    console.warn(`${label} skipped: ${error.message}`);
    return [];
  }
}

const feed = JSON.parse(await readFile(FEED, 'utf8'));
let changed = false;

if (DAYTIME) {
  changed = merge(feed, 'fadlallah', await attempt('Fadlallah calendar', fadlallahCalendar), { revisable: true }) || changed;
  changed = merge(feed, 'sistani', await attempt('sistani.org header', sistaniHeader)) || changed;
  changed = merge(feed, 'khamenei', await attempt('Al-Manar header', khameneiHeader)) || changed;
}
changed = merge(feed, 'sistani', await attempt('Sistani statements', sistaniStatements)) || changed;
changed = merge(feed, 'khamenei', await attempt('Lebanon office statements', () => khameneiStatements(feed))) || changed;

if (changed) {
  for (const authority of Object.keys(feed.monthStarts)) {
    feed.monthStarts[authority] = Object.fromEntries(Object.entries(feed.monthStarts[authority]).sort());
    feed.sources[authority] = Object.fromEntries(Object.entries(feed.sources[authority] ?? {}).sort());
  }
  feed.updatedAt = NOW.toISOString().replace(/\.\d+Z$/, 'Z');
  await writeFile(FEED, `${JSON.stringify(feed, null, 2)}\n`);
  console.log('month-starts.json updated');
} else {
  console.log('no changes');
}

if (problems.length) {
  console.error(`\nNeeds a human (edit month-starts.json):\n- ${problems.join('\n- ')}`);
  process.exit(1);
}
