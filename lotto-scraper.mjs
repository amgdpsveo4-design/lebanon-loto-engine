#!/usr/bin/env node
/**
 * أرشيف اللوتو اللبناني — جالب البيانات
 * ---------------------------------------------------
 * يجلب كل سحوبات اللوتو اللبناني (6/42) من lebanon-lotto.com
 * ويكتبها في draws.json بصيغة يقرأها محرك التحليل مباشرة.
 *
 * لا يحتاج أي حزم خارجية. Node 18 فما فوق.
 *
 *   node lotto-scraper.mjs                 # يجلب من حيث توقف حتى آخر سحب
 *   node lotto-scraper.mjs --from 1 --to 2443
 *   node lotto-scraper.mjs --fresh         # يتجاهل الملف الموجود ويبدأ من الصفر
 *
 * التشغيل الأول يستغرق ~25 دقيقة (2443 صفحة، 500ms بين الطلبات).
 * التحديثات اللاحقة تستغرق ثوانٍ — يجلب السحوبات الجديدة فقط.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

const BASE = 'https://www.lebanon-lotto.com/lebanese-loto-results/draw-number';
const OUT = path.resolve('draws.json');
const DELAY_MS = 500;          // احترام الخادم — لا تخفضه
const MAX_RETRIES = 3;
const CONSECUTIVE_MISS_STOP = 6; // بعد 6 صفحات فارغة متتالية نعتبر أننا وصلنا النهاية

const UA = 'Mozilla/5.0 (compatible; LotoArchive/1.0)';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- التحليل

/**
 * الصفحة تحتوي على سطر ثابت البنية:
 *   "..., Date: 2026-03-23, Numbers: 05,20,22,29,38,42,
 *    with Complimetary ball number: -- ."
 * وهذا أوثق مرساة في الصفحة كلها.
 */
function parseDraw(html, drawNumber) {
  const text = html.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ');

  const core = text.match(
    /Date:\s*(\d{4}-\d{2}-\d{2})\s*,\s*Numbers:\s*([0-9]{1,2}(?:\s*,\s*[0-9]{1,2}){5})\s*,\s*with\s+Complimetary\s+ball\s+number:\s*(--|[0-9]{1,2})/i
  );
  if (!core) return null;

  const [, date, numsRaw, bonusRaw] = core;
  const numbers = numsRaw.split(',').map((s) => parseInt(s.trim(), 10)).sort((a, b) => a - b);

  // فحص سلامة: 6 أرقام فريدة داخل المدى 1..42
  if (numbers.length !== 6) return null;
  if (new Set(numbers).size !== 6) return null;
  if (numbers.some((n) => !Number.isInteger(n) || n < 1 || n > 42)) return null;

  const bonus = bonusRaw === '--' ? null : parseInt(bonusRaw, 10);

  // أعداد الفائزين بالترتيب: 6 أرقام، 5+مكمل، 5، 4، 3
  const winners = [...text.matchAll(/Total\s+Winners:\s*([\d,]+)/gi)]
    .map((m) => parseInt(m[1].replace(/,/g, ''), 10))
    .slice(0, 5);

  // الجوائز لكل فئة
  const prizes = [...text.matchAll(/Prize:\s*([\d,]+)\s*Lebanese\s+Pounds/gi)]
    .map((m) => parseInt(m[1].replace(/,/g, ''), 10));

  const totalMatch = text.match(/Total\s+Winnings\s+for\s+this\s+draw\s+was:\s*([\d,]+)/i);

  return {
    n: drawNumber,
    date,
    numbers,
    bonus,
    // فئات الفائزين: [match6, match5plus, match5, match4, match3]
    winners: winners.length === 5 ? winners : null,
    prizes: prizes.length ? prizes : null,
    totalPool: totalMatch ? Number(totalMatch[1].replace(/,/g, '')) : null,
  };
}

// ---------------------------------------------------------------- الجلب

async function fetchDraw(n) {
  const url = `${BASE}/${n}.php`;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA }, redirect: 'follow' });
      if (res.status === 404) return { missing: true };
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const html = await res.text();
      const draw = parseDraw(html, n);
      return draw ? { draw } : { missing: true };
    } catch (err) {
      if (attempt === MAX_RETRIES) return { error: err.message };
      await sleep(DELAY_MS * attempt * 2);
    }
  }
}

/** يقرأ رقم آخر سحب معلن من صفحة "السحب القادم". */
async function detectLatest() {
  try {
    const res = await fetch('https://www.lebanon-lotto.com/past_results_list.php', {
      headers: { 'User-Agent': UA },
    });
    const html = await res.text();
    const nums = [...html.matchAll(/draw-number\/(\d+)\.php/g)].map((m) => Number(m[1]));
    return nums.length ? Math.max(...nums) : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- التشغيل

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

async function main() {
  const fresh = process.argv.includes('--fresh');

  let existing = [];
  if (!fresh) {
    try {
      const raw = JSON.parse(await fs.readFile(OUT, 'utf8'));
      existing = Array.isArray(raw) ? raw : raw.draws || [];
      console.log(`الأرشيف الحالي: ${existing.length} سحبة.`);
    } catch {
      console.log('لا يوجد أرشيف سابق. سنبدأ من الصفر.');
    }
  }

  const have = new Set(existing.map((d) => d.n));
  const highest = existing.length ? Math.max(...have) : 0;

  const latest = Number(arg('to', 0)) || (await detectLatest()) || highest + 20;
  const from = Number(arg('from', 0)) || 1;

  console.log(`سنغطي المدى ${from} → ${latest}. متوقع الجديد: ${latest - have.size} صفحة تقريباً.\n`);

  const collected = [...existing];
  let misses = 0;
  let added = 0;

  for (let n = from; n <= latest; n++) {
    if (have.has(n)) continue;

    const result = await fetchDraw(n);
    await sleep(DELAY_MS);

    if (result.error) {
      console.error(`  سحب ${n}: فشل (${result.error}) — سنتخطاه.`);
      continue;
    }
    if (result.missing) {
      misses++;
      if (n > highest && misses >= CONSECUTIVE_MISS_STOP) {
        console.log(`\nتوقفنا عند ${n}: ${CONSECUTIVE_MISS_STOP} صفحات فارغة متتالية.`);
        break;
      }
      continue;
    }

    misses = 0;
    collected.push(result.draw);
    added++;

    if (added % 25 === 0) {
      process.stdout.write(`  ${added} سحبة جديدة… (آخرها ${n} — ${result.draw.date})\n`);
      await save(collected);
    }
  }

  await save(collected);

  const sorted = collected.sort((a, b) => a.n - b.n);
  console.log(`\n— تم —`);
  console.log(`المجموع: ${sorted.length} سحبة (${added} جديدة)`);
  if (sorted.length) {
    console.log(`المدى: ${sorted[0].n} (${sorted[0].date}) → ${sorted.at(-1).n} (${sorted.at(-1).date})`);
    const withBonus = sorted.filter((d) => d.bonus !== null).length;
    const withWinners = sorted.filter((d) => d.winners).length;
    console.log(`رقم مكمّل متاح في ${withBonus} سحبة، أعداد الفائزين في ${withWinners} سحبة.`);
    const gaps = [];
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i].n !== sorted[i - 1].n + 1) gaps.push(`${sorted[i - 1].n}→${sorted[i].n}`);
    }
    if (gaps.length) console.log(`فجوات في الترقيم: ${gaps.slice(0, 10).join(', ')}${gaps.length > 10 ? '…' : ''}`);
  }
  console.log(`\nالملف: ${OUT}`);
  console.log(`ارفعه في المحرك عبر زر "استيراد الأرشيف".`);
}

async function save(rows) {
  const sorted = [...rows].sort((a, b) => a.n - b.n);
  await fs.writeFile(
    OUT,
    JSON.stringify(
      {
        source: 'lebanon-lotto.com',
        game: 'Lebanese Loto 6/42',
        fetchedAt: new Date().toISOString(),
        count: sorted.length,
        draws: sorted,
      },
      null,
      1
    )
  );
}

main().catch((e) => {
  console.error('توقف غير متوقع:', e);
  process.exit(1);
});
