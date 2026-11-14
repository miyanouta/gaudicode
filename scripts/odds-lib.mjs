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

// ---- 三連単・勝負「厳選セット版」: 展開優先 E2 (ユーザー決定 2026-11-15) ----
// 厳選セットは2つ: セット1 = 三連複・鉄板ポーションから、セット2 = バランス
// 追加分 (バランスにあって鉄板に無い組み合わせ) から、それぞれ「展開優先 E2」
// ルールで1組ずつ選ぶ。三連単・勝負 = セット1・セット2 それぞれの全6順序
// (ソート済みセットに対する [abc, acb, bac, bca, cab, cba] の生成順、重複除き、
// 計12点)。片方の層にオッズ付き買い目が無い場合は、ある方だけの6点になる。
//
// E2 ルール (ポーションごと): ポーションのオッズ付き組み合わせのうち
// 低オッズ3組を候補とし、
//   1. 展開の軸ペア (本線ラインの先頭車 + 番手) を両方含む組があれば、その中の最小オッズ
//   2. 無ければ軸の先頭車を含む組の中の最小オッズ
//   3. 無ければポーションの最小オッズ (従来ルール)
// 本線ライン = 先頭車の先行プロフィールが最も強いライン。判定は
// 脚質 style (逃>両>捲>追) → 決まり手の逃げ回数 nige → 競走得点 tokuten →
// ◎を含むライン、の順。本線が単騎の場合は軸ペアは先頭車のみに縮退する。
// 並び (lineup) が無いレースは軸が決められないため、従来の最小オッズ選択に
// フォールバックする。
//
// 検証 (2026-11-09〜14 の421レース、保存された確定オッズ+並びで構築):
// 従来の最小オッズ選択が 的中31.1%・回収76.5%・的中万車券7件 だったのに対し、
// E2 は 的中27.8%・回収132.3%・的中万車券9件 (厳選2点の三連複でも
// 的中27.8%・回収73.4%)。四日市10R (2-4-7、三連単¥310,950) のような
// 大物車券を軸ペアで拾えるため、ユーザーが的中率の低下 (約-3.3pt) を
// 受け入れて採用を決定した (2026-11-15)。
// 実運用ではレース前に取得したオッズで構築し、発走後は凍結する
// (結果が出た後に作り直さない) ため、確定オッズの検証値とは多少ずれる。
//
// ---- B: 選定=勝負追加分のレースだけ3組目を追加 (ユーザー決定 2026-11-15) ----
// 3区分 (鉄板 / バランス追加分 / 勝負追加分) の平均オッズを比べ、勝負追加分が
// 選定 (最も低い、同点を含む) になったレースでのみ、勝負追加分の E2 ピックを
// 3組目として全6順序を加える (そのレースだけ18点、他は従来通り12点)。
// 平均は区分内のオッズ付き組み合わせの平均 (除外なし)。検証 (上記421レース、
// 本番コードで再構築): 的中28.7%・回収133.6%・的中万車券10件・平均12.6点、
// 発動は40レース (9.5%)。非発動レースの出力は E2 のみの従来構築と完全一致。
// 3組目のピックだけは、未発売の番兵値 9999.9 を「オッズ無し」として除外した
// 勝負追加分から選ぶ (有効な組が無ければ追加しない)。検証対象では番兵値の
// 除外は発動レースのピックを変えず (421レース全てで出力一致)、朝の発売前
// オッズで幻の組を掴まないための安全策として新しい経路にだけ入れている。
// なお区分平均とセット1・2の選択は、ユーザーが承認した測定 (スタディ) の
// 定義そのままで、番兵値を除外すると発動が41レース・回収133.4% にずれて
// 承認済みの数字を再現できなくなるため、そちらには手を入れていない。
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
const STYLE_RANK = { '逃': 3, '両': 2, '捲': 1, '追': 0 };
// 展開の軸ペア: 本線ラインの先頭車と番手を { front, second } で返す。
// 並びが無い・判定できない場合は null (呼び出し側で最小オッズ選択に落とす)。
export function axisPairOf(race) {
  if (!race || !Array.isArray(race.riders) || !Array.isArray(race.lineup) || !race.lineup.length) return null;
  const rider = new Map(race.riders.map((x) => [x.num, x]));
  const hon = race.riders.find((x) => x.gaudiMark === '◎');
  let best = null;
  for (const line of race.lineup) {
    if (!Array.isArray(line) || !line.length) continue;
    const front = rider.get(line[0]);
    if (!front) continue;
    const cand = {
      front: front.num,
      second: line.length >= 2 ? line[1] : null,
      styleRank: STYLE_RANK[front.style] ?? 0,
      nige: front.nige || 0,
      tokuten: front.tokuten || 0,
      hasHon: hon ? line.includes(hon.num) : false,
    };
    if (!best) { best = cand; continue; }
    const better =
      cand.styleRank > best.styleRank ||
      (cand.styleRank === best.styleRank && cand.nige > best.nige) ||
      (cand.styleRank === best.styleRank && cand.nige === best.nige && cand.tokuten > best.tokuten) ||
      (cand.styleRank === best.styleRank && cand.nige === best.nige && cand.tokuten === best.tokuten && cand.hasHon && !best.hasHon);
    if (better) best = cand;
  }
  return best ? { front: best.front, second: best.second } : null;
}
// ポーション (プランの組み合わせリスト) から厳選セットを1組選ぶ (E2)。
// axis が null の場合は従来の最小オッズ選択と同一の結果になる。
export function pickGensenSet(oddsMap, planList, axis) {
  if (!oddsMap || !Array.isArray(planList) || !planList.length) return null;
  const sets = [...new Set(planList.map(norm))].filter((c) => oddsMap[c] != null);
  if (!sets.length) return null;
  const byOdds = (a, b) => oddsMap[a] - oddsMap[b];
  const minOf = (list) => [...list].sort(byOdds)[0];
  if (!axis) return minOf(sets);
  const pairNums = axis.second != null ? [axis.front, axis.second] : [axis.front];
  const hasAll = (c, nums) => { const ns = c.split('-').map(Number); return nums.every((n) => ns.includes(n)); };
  const top3 = [...sets].sort(byOdds).slice(0, 3);
  const withPair = top3.filter((c) => hasAll(c, pairNums));
  if (withPair.length) return minOf(withPair);
  const withKey = top3.filter((c) => hasAll(c, [axis.front]));
  if (withKey.length) return minOf(withKey);
  return minOf(sets);
}
export function buildGensenTanShoubu(plans, oddsMap, axis = null) {
  if (!plans || !oddsMap) return null;
  const tep = (plans.teppan || []).map(norm);
  const bal = (plans.balance || []).map(norm);
  const sho = (plans.shoubu || []).map(norm);
  const tepSet = new Set(tep);
  const set1 = pickGensenSet(oddsMap, tep, axis);
  const balAdd = bal.filter((c) => !tepSet.has(c));
  const set2 = pickGensenSet(oddsMap, balAdd, axis);
  const sets = [set1, set2];
  // B: 選定 (区分平均オッズが最小、同点を含む) が勝負追加分のレースだけ、
  // 勝負追加分の E2 ピックを3組目として追加する (詳細は冒頭コメント)。
  const covered = new Set([...tep, ...bal]);
  const shoAdd = sho.filter((c) => !covered.has(c));
  const portionAvg = (list) => {
    const vals = [...new Set(list)].filter((c) => oddsMap[c] != null).map((c) => oddsMap[c]);
    return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : Infinity;
  };
  const aS = portionAvg(shoAdd);
  if (aS <= portionAvg(tep) && aS <= portionAvg(balAdd)) {
    // 3組目のピックは番兵値 9999.9 を「オッズ無し」として除外して選ぶ
    const shoValid = shoAdd.filter((c) => oddsMap[c] != null && oddsMap[c] !== 9999.9);
    const set3 = pickGensenSet(oddsMap, shoValid, axis);
    if (set3) sets.push(set3);
  }
  const out = [];
  for (const s of sets) {
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
  const g = buildGensenTanShoubu(p.plans, race.odds, axisPairOf(race));
  if (!g) return false;
  p.plansTan.shoubu = g;
  p.tanBasis = 'gensen';
  return true;
}
