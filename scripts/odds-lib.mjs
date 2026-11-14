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

// ---- 三連単・勝負「厳選セット版」(ユーザー決定 2026-11-14) ----
// 厳選セット1 = 三連複・鉄板プラン内の最小オッズの組み合わせ、
// 厳選セット2 = バランス追加分 (バランスにあって鉄板に無い組み合わせ) の最小オッズ。
// 三連単・勝負 = セット1・セット2 それぞれの全6順序 (ソート済みセットに対する
// [abc, acb, bac, bca, cab, cba] の生成順、重複除き、計12点)。
// 片方の層にオッズ付き買い目が無い場合は、ある方だけの6点になる。
// 検証 (2026-11-09〜13 の392レース、保存された確定オッズで構築):
// 的中31.9% (125件)・回収79.7%・的中万車券7件・平均12.0点。
// 実運用ではレース前に取得したオッズで構築し、発走後は凍結する
// (結果が出た後に作り直さない) ため、確定オッズの検証値とは多少ずれる。
export function minOddsCombo(oddsMap, planList) {
  if (!oddsMap || !Array.isArray(planList) || !planList.length) return null;
  let best = null, bestOdds = Infinity;
  for (const c of planList) {
    const k = norm(c);
    const o = oddsMap[k];
    if (o != null && o < bestOdds) { bestOdds = o; best = k; }
  }
  return best;
}
export function buildGensenTanShoubu(plans, oddsMap) {
  if (!plans || !oddsMap) return null;
  const tep = (plans.teppan || []).map(norm);
  const bal = (plans.balance || []).map(norm);
  const tepSet = new Set(tep);
  const set1 = minOddsCombo(oddsMap, tep);
  const set2 = minOddsCombo(oddsMap, bal.filter((c) => !tepSet.has(c)));
  const out = [];
  for (const s of [set1, set2]) {
    if (!s) continue;
    const [a, b, c] = s.split('-').map(Number);
    for (const p of [[a, b, c], [a, c, b], [b, a, c], [b, c, a], [c, a, b], [c, b, a]]) {
      const t = p.join('→');
      if (!out.includes(t)) out.push(t);
    }
  }
  return out.length ? out : null;
}
// レースに保存されたオッズから厳選版の三連単・勝負を構築し prediction に反映する。
// 反映できたら true を返し prediction.tanBasis='gensen' を立てる。
// オッズやプランが無く構築できない場合は何もせず false (勝負はA案のまま)。
export function applyGensenTan(race) {
  const p = race && race.prediction;
  if (!p || !p.plans || !p.plansTan || !race.odds) return false;
  const g = buildGensenTanShoubu(p.plans, race.odds);
  if (!g) return false;
  p.plansTan.shoubu = g;
  p.tanBasis = 'gensen';
  return true;
}
