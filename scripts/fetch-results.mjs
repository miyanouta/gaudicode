// ============================================================
// GAUDICODE 競輪サイト 結果取得スクリプト
// ------------------------------------------------------------
// 指定日のレース結果 (着順・三連複/三連単の払戻) を楽天Kドリームスから
// 取得し、data/<date>.json の各レースに result としてマージする。
// あわせて予想プラン (鉄板/バランス/勝負) と三連単の的中判定も記録する。
// まだ結果が出ていないレースは result を付けずに残す (再実行で埋まる)。
//
// 使い方:
//   node scripts/fetch-results.mjs [YYYY-MM-DD] [--venue=<slug>]
// 前提: その日の data/<date>.json が存在すること (先に出走表を取得)。
// ============================================================
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { parseSanrenpukuOdds, applyGensenTan } from './odds-lib.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const DELAY_MS = 500;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchHtml(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'ja' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return await res.text();
}

function jstToday() {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit' });
  return f.format(new Date());
}

// 結果一覧ページ -> 結果詳細リンク (pageType=showResult)
function findResultLinks(indexHtml, base) {
  const links = new Map();
  const re = /href="([^"]*racedetail[^"]*showResult[^"]*)"/gi;
  let m;
  while ((m = re.exec(indexHtml)) !== null) {
    let url;
    try { url = new URL(m[1], base).toString(); } catch { continue; }
    const seg = new URL(url).pathname.split('/').filter(Boolean);
    const venueSlug = seg[0] || 'unknown';
    const noMatch = url.match(/(\d{1,2})(?:[^\d]*)$/);
    links.set(url, { venueSlug, raceNo: noMatch ? Number(noMatch[1]) : null, url });
  }
  return [...links.values()];
}

// 結果詳細ページ -> { top3:[車番...], sanrenpuku:{combo,payout}, sanrentan:{combo,payout} }
function parseResult(html) {
  const dom = new JSDOM(html);
  const doc = dom.window.document;
  // 着順テーブル (ヘッダーに 着順 と 車番 を含む最初の表)
  let top3 = null;
  for (const tb of doc.querySelectorAll('table')) {
    const rows = [...tb.querySelectorAll('tr')];
    if (!rows.length) continue;
    const head = [...rows[0].children].map((c) => c.textContent.trim());
    const ri = head.indexOf('着順'); const ni = head.indexOf('車番');
    if (ri < 0 || ni < 0) continue;
    const placed = [];
    for (const tr of rows.slice(1)) {
      const cells = [...tr.children].map((c) => c.textContent.trim());
      const rank = Number(cells[ri]); const num = Number(cells[ni]);
      if (rank >= 1 && rank <= 3 && num >= 1 && num <= 9) placed.push({ rank, num });
    }
    if (placed.length >= 3) { top3 = placed.sort((a, b) => a.rank - b.rank).slice(0, 3).map((p) => p.num); }
    break;
  }
  if (!top3) return null;
  // 払戻: 三連複は dt が "2=3=5" 形式、三連単は "2-5-3" 形式
  const pay = (re) => {
    for (const dt of doc.querySelectorAll('dt')) {
      const t = dt.textContent.trim();
      if (!re.test(t)) continue;
      const dd = dt.nextElementSibling;
      const amt = dd ? Number((dd.textContent.match(/([\d,]+)円/) || [])[1]?.replace(/,/g, '')) : null;
      return { combo: t.replace(/=/g, '-'), payout: amt ?? null };
    }
    return null;
  };
  return {
    top3,
    sanrenpuku: pay(/^\d+=\d+=\d+$/),
    sanrentan: pay(/^\d+-\d+-\d+$/),
  };
}

const norm = (s) => s.split('-').map(Number).sort((a, b) => a - b).join('-');

// 発走済みかどうか (startTime は JST の "H:MM" 表記)。発走後は三連単・勝負
// (厳選版) を凍結し、レース後のオッズで予想を作り直さない。オッズ自体は
// 結果確定時に確定オッズを1回だけ保存する (旧仕様の復元、下記 main 内)。
// startTime が取れていないレースは未発走扱い (従来どおり結果が出るまで更新)。
function raceStarted(r) {
  if (!r.startTime) return false;
  const m = String(r.startTime).match(/(\d{1,2}):(\d{2})/);
  if (!m) return false;
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Tokyo' }));
  return now.getHours() * 60 + now.getMinutes() >= Number(m[1]) * 60 + Number(m[2]);
}

function evaluate(race, result) {
  const hits = {};
  const p = race.prediction;
  if (p?.plans && result.sanrenpuku) {
    const key = norm(result.sanrenpuku.combo);
    for (const tier of ['teppan', 'balance', 'shoubu']) {
      if (Array.isArray(p.plans[tier])) hits[tier] = p.plans[tier].map(norm).includes(key);
    }
  }
  if (p?.plansTan && result.sanrentan) {
    const ordered = result.sanrentan.combo.replace(/-/g, '→');
    for (const tier of ['teppan', 'balance', 'shoubu']) {
      if (Array.isArray(p.plansTan[tier])) hits['tan' + tier[0].toUpperCase() + tier.slice(1)] = p.plansTan[tier].includes(ordered);
    }
    hits.sanrentan = hits.tanTeppan;
  } else if (p?.sanrentan && result.sanrentan) {
    const ordered = result.sanrentan.combo.replace(/-/g, '→');
    hits.sanrentan = p.sanrentan.includes(ordered);
  }
  return hits;
}

async function main() {
  const args = process.argv.slice(2);
  const dateStr = args.find((a) => /^\d{4}-\d{2}-\d{2}$/.test(a)) || jstToday();
  const venueFilter = (args.find((a) => a.startsWith('--venue=')) || '').split('=')[1] || null;
  const dataPath = path.join(ROOT, 'data', `${dateStr}.json`);
  if (!fs.existsSync(dataPath)) throw new Error(`data/${dateStr}.json がありません。先に出走表を取得してください。`);
  const data = JSON.parse(fs.readFileSync(dataPath, 'utf8'));

  const [Y, M, D] = dateStr.split('-');
  const indexUrl = `https://keirin.kdreams.jp/raceresult/${Y}/${M}/${D}/`;
  console.log(`[results] ${indexUrl}`);
  const indexHtml = await fetchHtml(indexUrl);
  let links = findResultLinks(indexHtml, indexUrl);
  if (venueFilter) links = links.filter((l) => l.venueSlug === venueFilter);
  console.log(`[results] 結果リンク: ${links.length}件`);
  const byKey = new Map(links.map((l) => [`${l.venueSlug}:${l.raceNo}`, l]));

  let updated = 0, pending = 0, failed = 0;
  for (const v of data.venues) {
    for (const r of v.races) {
      const link = byKey.get(`${v.id}:${r.no}`);
      if (!link) { pending++; continue; }
      const hadResult = !!r.result;
      try {
        const html = await fetchHtml(link.url);
        const result = parseResult(html);
        if (!result) { pending++; }
        else {
          r.result = { ...result, hits: evaluate(r, result) };
          updated++;
        }
      } catch (e) {
        failed++;
        console.log(`[results] ${v.id} ${r.no}R 取得失敗: ${e.message || e}`);
      }
      // 結果が今回確定したレースは、確定オッズを保存する (旧仕様の復元)。
      // 旧仕様では発走後も「結果が未記録な間はオッズ更新が走る」ため、終了した
      // レースの保存オッズは最終的に確定オッズになっていた。厳選版の導入で
      // 発走時点の凍結を入れた際、オッズまで止まってしまったので、結果確定の
      // タイミングで1回だけ確定オッズを取り直す。三連単・勝負は発走時点で
      // 凍結されたままにし、ここでは再構築しない (applyGensenTan は呼ばない)。
      if (!hadResult && r.result) {
        try {
          const base = link.url.split('?')[0];
          const oh = await fetchHtml(base + '?pageType=odds&kakeshikiType=3renhuku');
          const odds = parseSanrenpukuOdds(oh);
          if (odds) { r.odds = odds; r.oddsAt = new Date().toISOString(); }
        } catch { /* 確定オッズの保存失敗は無視 (結果の記録自体は済んでいる) */ }
      }
      // 朝固定 (2026-11-16 採用): 厳選は朝の生成で確定させ、以後は作り直さ
      // ない。ここで作るのは、朝に厳選が付かなかったレース (オッズ取得失敗
      // など) への初回適用だけ。一度付いた厳選と保存オッズは二度と変えない。
      // 過去日の再実行でも、結果を取りこぼしたレースをレース後オッズで
      // 作り直さないよう、日付が過ぎたデータは凍結する。
      const frozen = dateStr < jstToday() || raceStarted(r);
      if (!r.result && r.prediction && !frozen && r.prediction.tanBasis !== 'gensen') {
        try {
          const base = link.url.split('?')[0];
          const oh = await fetchHtml(base + '?pageType=odds&kakeshikiType=3renhuku');
          const odds = parseSanrenpukuOdds(oh);
          if (odds) {
            r.odds = odds; r.oddsAt = new Date().toISOString();
            applyGensenTan(r);
          }
        } catch { /* オッズ更新失敗は無視 */ }
      }
      await sleep(DELAY_MS);
    }
  }
  data.resultsUpdatedAt = new Date().toISOString();
  fs.writeFileSync(dataPath, JSON.stringify(data, null, 2), 'utf8');
  console.log(`[done] 結果を記録: ${updated}レース / 未確定: ${pending} / 失敗: ${failed}`);
}

main().catch((e) => { console.error('[fatal]', e); process.exit(1); });
