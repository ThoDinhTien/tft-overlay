#!/usr/bin/env node
/**
 * Trộn số liệu thật (comps_stats.json từ Riot) thành comps.json engine dùng:
 *  - làm sạch tên (apiName → tên hiển thị)
 *  - lọc coreUnits chỉ giữ tướng thật (bỏ summon/minion)
 *  - suy levelToCommit từ giá carry
 *  - giữ top N comp đủ mẫu, sắp theo avgPlacement
 *
 *   node scripts/merge_stats.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const DIR = path.resolve(import.meta.dirname, '../data');
const TOP_N = 24;
const MIN_GAMES = 18;

const champs = new Map(
  JSON.parse(readFileSync(path.join(DIR, 'champions.json'))).champions.map((c) => [c.apiName, c])
);
const traitName = new Map(
  JSON.parse(readFileSync(path.join(DIR, 'traits.json'))).traits.map((t) => [t.apiName, t.name])
);
const stats = JSON.parse(readFileSync(path.join(DIR, 'comps_stats.json')));

const levelToCommit = (cost) => (cost <= 2 ? 6 : cost === 3 ? 7 : cost === 4 ? 8 : 9);
// Item apiName -> tên hiển thị: bỏ tiền tố TFT_Item_, tách camelCase.
const prettyItem = (raw) =>
  raw
    .replace(/^TFT\d*_Item_/, '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/_/g, ' ')
    .trim();
const playstyle = (cost) =>
  cost <= 2 ? 'Reroll giá rẻ — đánh sớm, dồn lên 3 sao carry.'
  : cost === 3 ? 'Reroll/flex quanh lv7, cân giữa tempo và trần sức mạnh.'
  : 'Fast level, giữ máu, mạnh late — ưu tiên hit carry giá cao.';

const comps = stats.comps
  .filter((c) => c.stats.games >= MIN_GAMES)
  .map((c) => {
    const carry = c.carryUnits[0];
    const carryCost = champs.get(carry)?.cost ?? 0;
    const core = c.coreUnits.filter((u) => champs.has(u)); // bỏ summon/minion
    const traitsTxt = c.keyTraits.map((t) => traitName.get(t) || t).join(' ');
    const carryTxt = champs.get(carry)?.name || carry.replace(/^TFT\d+_/, '');
    return {
      id: c.id,
      name: `${traitsTxt} - ${carryTxt}`,
      tier: c.tier,
      stats: c.stats,
      coreUnits: core,
      carryUnits: c.carryUnits,
      keyTraits: c.keyTraits,
      carryItems: (c.carryItemsRaw || []).length
        ? { [carry]: c.carryItemsRaw.map(prettyItem) }
        : {},
      levelToCommit: carryCost ? levelToCommit(carryCost) : 0,
      playstyle: playstyle(carryCost),
      positioningHint: '',
    };
  })
  .filter((c) => champs.has(c.carryUnits[0]) && c.coreUnits.length >= 3)
  .sort((a, b) => a.stats.avgPlacement - b.stats.avgPlacement)
  .slice(0, TOP_N);

writeFileSync(
  path.join(DIR, 'comps.json'),
  JSON.stringify(
    {
      _comment: `Sinh tự động từ comps_stats.json (${stats.sampleMatches} trận challenger VN). Chạy lại scripts/merge_stats.mjs sau mỗi lần aggregate.`,
      patch: 'Set17-riot',
      source: 'riot',
      comps,
    },
    null,
    2
  )
);

console.log(`✓ Ghi ${comps.length} comp (top theo avgPlacement, >=${MIN_GAMES} trận) vào comps.json`);
comps.slice(0, 8).forEach((c, i) =>
  console.log(`  ${i + 1}. [${c.tier}] ${c.name}  avg ${c.stats.avgPlacement} top4 ${(c.stats.top4Rate * 100) | 0}% (${c.stats.games}g) lv${c.levelToCommit}`)
);
