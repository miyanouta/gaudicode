// 三連複オッズの取得・解析と、期待値モデル (共有ライブラリ)
// オッズページ: racedetail URL + ?pageType=odds&kakeshikiType=3renhuku
// 確率モデル: 印・競走得点・補助層の含有からライダーの3着内確率を推定し、
// 組み合わせ確率は積→正規化の近似で出す (モデル推定であり実測ではない)。
export function parseSanrenpukuOdds(html) {
  const start = html.indexOf('複オッズ表 Start');
  const end = html.indexOf('複オッズ表 End');
  if (start < 0 || end < 0) return null;
  const seg = html.slice(start, end);
  const odds = {};
  // ライダーごとの表: 先頭の <th class="nX" colspan="3">A</th> が軸
  const tables = seg.split('<table class="odds_table">').slice(1);
  for (const t of tables) {
    const am = t.match(/<th class="n\d" colspan="3">(\d)<\/th>/);
    if (!am) continue;
    const A = Number(am[1]);
    let B = null;
    const rowRe = /<th class="n\d"(?: rowspan="\d+")?>(\d)<\/th>\s*(?:<th class="n\d">(\d)<\/th>\s*)?<td>([0-9.]+)<\/td>/g;
    let m;
    while ((m = rowRe.exec(t)) !== null) {
      let b, c;
      if (m[2] !== undefined) { b = Number(m[1]); c = Number(m[2]); }
      else { if (B === null) continue; b = B; c = Number(m[1]); }
      B = b;
      const key = [A, b, c].sort((x, y) => x - y).join('-');
      odds[key] = Number(m[3]);
    }
  }
  return Object.keys(odds).length ? odds : null;
}

const MARK_SCORE = { '◎': 3.0, '○': 2.2, '▲': 1.6, '☆': 1.3, '△': 0.7 };
export function comboProbabilities(riders, auxPuku) {
  if (!riders || riders.length < 3) return null;
  const toks = riders.map((r) => r.tokuten || 0);
  const tMin = Math.min(...toks), tMax = Math.max(...toks);
  const auxCount = new Map();
  if (Array.isArray(auxPuku)) for (const c of auxPuku) for (const n of c.split('-').map(Number))
    auxCount.set(n, (auxCount.get(n) || 0) + 1);
  const w = riders.map((r) => {
    const mark = MARK_SCORE[r.gaudiMark] ?? 0.3;
    const tok = tMax > tMin ? (r.tokuten - tMin) / (tMax - tMin) : 0.5;
    const aux = (auxCount.get(r.num) || 0) * 0.45;
    return Math.exp(mark + tok * 1.2 + aux);
  });
  const sum = w.reduce((a, b) => a + b, 0);
  const p3 = riders.map((r, i) => ({ num: r.num, p: 3 * w[i] / sum }));
  // 組み合わせ確率: p_a*p_b*p_c を全組み合わせで正規化
  const combos = new Map();
  let tot = 0;
  for (let i = 0; i < p3.length; i++) for (let j = i + 1; j < p3.length; j++) for (let k = j + 1; k < p3.length; k++) {
    const v = p3[i].p * p3[j].p * p3[k].p;
    combos.set([p3[i].num, p3[j].num, p3[k].num].sort((a, b) => a - b).join('-'), v);
    tot += v;
  }
  if (!(tot > 0)) return null;
  for (const [k, v] of combos) combos.set(k, v / tot);
  return combos;
}

const norm = (s) => s.split('-').map(Number).sort((a, b) => a - b).join('-');
// プラン期待値: 1点100円で買った場合の期待回収率 (1.0 = 収支トントン)
export function planEV(combos, oddsMap, planList) {
  if (!combos || !oddsMap || !Array.isArray(planList) || !planList.length) return null;
  let ev = 0, covered = 0;
  for (const c of planList) {
    const k = norm(c);
    const p = combos.get(k), o = oddsMap[k];
    if (p !== undefined && o) { ev += p * o; covered++; }
  }
  if (!covered) return null;
  return { ev: ev / planList.length, covered, points: planList.length };
}
export function computeEV(race) {
  if (!race || !race.prediction || !race.odds) return null;
  const combos = comboProbabilities(race.riders, race.prediction.auxPuku);
  if (!combos) return null;
  const pl = race.prediction.plans || {};
  return {
    teppan: planEV(combos, race.odds, pl.teppan),
    balance: planEV(combos, race.odds, pl.balance),
    shoubu: planEV(combos, race.odds, pl.shoubu),
  };
}
