#!/usr/bin/env node
/**
 * TỰ TÍNH winrate/đội hình từ data trận THẬT qua Riot TFT API.
 * Đây là nguồn "winrate thật" hợp pháp & bền (không scrape site bên thứ ba).
 *
 * Luồng: challenger league → puuid người chơi → match ids → chi tiết trận
 *        → gom mỗi người chơi thành 1 "comp signature" (2 trait mạnh nhất + carry)
 *        → tính avgPlacement / top4Rate / winRate / playRate cho từng comp.
 *
 * Chạy:
 *   RIOT_API_KEY=RGAPI-xxxx \
 *   PLATFORM=vn2 REGION=asia \           # VN: platform=vn2, region=asia
 *   PLAYERS=40 MATCHES_PER_PLAYER=15 \
 *   node scripts/aggregate_comps.mjs
 *
 * ⚠ Dev key Riot giới hạn ~100 request / 2 phút → mặc định để nhỏ. Production
 *   key thì tăng PLAYERS/MATCHES lên. Kết quả ghi ra assets/comps_stats.json;
 *   trộn vào comps.json (điền field "stats") để engine dùng số thật.
 */
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

const KEY = process.env.RIOT_API_KEY;
const PLATFORM = process.env.PLATFORM || 'vn2';     // host league/summoner
const REGION = process.env.REGION || 'asia';        // host match (americas|asia|europe|sea)
const TIER = process.env.TIER || 'challenger';       // challenger|grandmaster|master
const PLAYERS = Number(process.env.PLAYERS || 40);
const MATCHES_PER_PLAYER = Number(process.env.MATCHES_PER_PLAYER || 15);
const MIN_GAMES = Number(process.env.MIN_GAMES || 15); // bỏ comp quá ít mẫu
const TOP_CORE = 8;                                   // số tướng lõi giữ lại / comp

const ASSET_DIR = path.resolve(import.meta.dirname, '../data');

if (!KEY) {
  console.error('✗ Thiếu RIOT_API_KEY. Lấy key tại https://developer.riotgames.com');
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Gọi Riot API có throttle + tự retry khi 429. */
let lastCall = 0;
async function riot(host, endpoint) {
  // Giãn tối thiểu 1.3s/call để né giới hạn 100 req / 2 phút của dev key.
  const wait = 1300 - (Date.now() - lastCall);
  if (wait > 0) await sleep(wait);
  lastCall = Date.now();

  const url = `https://${host}.api.riotgames.com${endpoint}`;
  const res = await fetch(url, { headers: { 'X-Riot-Token': KEY } });
  if (res.status === 429) {
    const retry = Number(res.headers.get('retry-after') || 10);
    console.warn(`  ⏳ 429 rate limit, chờ ${retry}s…`);
    await sleep((retry + 1) * 1000);
    return riot(host, endpoint);
  }
  if (!res.ok) throw new Error(`${res.status} ${endpoint}`);
  return res.json();
}

/** Xác định "comp signature" của 1 người chơi trong 1 trận. */
function signature(participant) {
  // Trait đang kích hoạt, mạnh nhất theo số quân.
  const active = (participant.traits || [])
    .filter((t) => t.tier_current > 0)
    .sort((a, b) => b.num_units - a.num_units);
  const keyTraits = active.slice(0, 2).map((t) => t.name);

  // Carry = quân nhiều item nhất, ưu tiên rarity cao & sao cao.
  const units = participant.units || [];
  const carry = [...units].sort((a, b) => {
    const ai = (a.itemNames || []).length, bi = (b.itemNames || []).length;
    if (bi !== ai) return bi - ai;
    if ((b.rarity || 0) !== (a.rarity || 0)) return (b.rarity || 0) - (a.rarity || 0);
    return (b.tier || 0) - (a.tier || 0);
  })[0];
  const carryId = carry?.character_id || 'unknown';

  return {
    key: [...keyTraits].sort().join('+') + '|' + carryId,
    keyTraits,
    carryId,
    carryItems: carry?.itemNames || [],   // item challenger ghép cho carry
    units: units.map((u) => u.character_id),
  };
}

function tierFromPlacement(avg) {
  if (avg <= 3.9) return 'S';
  if (avg <= 4.3) return 'A';
  if (avg <= 4.6) return 'B';
  return 'C';
}

async function main() {
  console.log(`→ Lấy ${TIER} (${PLATFORM}) …`);
  const league = await riot(PLATFORM, `/tft/league/v1/${TIER}?queue=RANKED_TFT`);
  const entries = (league.entries || []).slice(0, PLAYERS);
  console.log(`→ ${entries.length} người chơi, mỗi người ${MATCHES_PER_PLAYER} trận.`);

  // Thu thập match id (dedupe).
  const matchIds = new Set();
  for (const [i, e] of entries.entries()) {
    const puuid = e.puuid;
    if (!puuid) continue; // league entry phải có puuid (Riot API mới)
    try {
      const ids = await riot(REGION, `/tft/match/v1/matches/by-puuid/${puuid}/ids?count=${MATCHES_PER_PLAYER}`);
      ids.forEach((id) => matchIds.add(id));
      process.stdout.write(`\r  match ids: ${matchIds.size} (player ${i + 1}/${entries.length})`);
    } catch (err) {
      console.warn(`\n  ⚠ player ${i + 1}: ${err.message}`);
    }
  }
  console.log(`\n→ ${matchIds.size} trận khác nhau. Đang tải chi tiết…`);

  // Gom thống kê theo signature.
  const agg = new Map();
  let totalParticipants = 0, done = 0;
  for (const id of matchIds) {
    let match;
    try {
      match = await riot(REGION, `/tft/match/v1/matches/${id}`);
    } catch (err) {
      console.warn(`\n  ⚠ match ${id}: ${err.message}`);
      continue;
    }
    for (const p of match.info?.participants || []) {
      totalParticipants++;
      const sig = signature(p);
      let a = agg.get(sig.key);
      if (!a) {
        a = { keyTraits: sig.keyTraits, carryId: sig.carryId, games: 0, sumPlace: 0, top4: 0, wins: 0, unitFreq: new Map(), itemFreq: new Map() };
        agg.set(sig.key, a);
      }
      a.games++;
      a.sumPlace += p.placement;
      if (p.placement <= 4) a.top4++;
      if (p.placement === 1) a.wins++;
      for (const u of sig.units) a.unitFreq.set(u, (a.unitFreq.get(u) || 0) + 1);
      for (const it of sig.carryItems) a.itemFreq.set(it, (a.itemFreq.get(it) || 0) + 1);
    }
    done++;
    process.stdout.write(`\r  trận: ${done}/${matchIds.size}`);
  }
  console.log('');

  // Xuất comp.
  const comps = [...agg.values()]
    .filter((a) => a.games >= MIN_GAMES)
    .map((a) => {
      const avg = a.sumPlace / a.games;
      const coreUnits = [...a.unitFreq.entries()]
        .sort((x, y) => y[1] - x[1])
        .slice(0, TOP_CORE)
        .map(([id]) => id);
      // 3 item challenger hay ghép nhất cho carry.
      const carryItems = [...a.itemFreq.entries()]
        .sort((x, y) => y[1] - x[1])
        .slice(0, 3)
        .map(([id]) => id);
      return {
        id: (a.keyTraits.join('-') + '-' + a.carryId).toLowerCase().replace(/[^a-z0-9-]/g, ''),
        name: `${a.keyTraits.join(' ')} - ${a.carryId}`,
        tier: tierFromPlacement(avg),
        stats: {
          avgPlacement: Number(avg.toFixed(3)),
          top4Rate: Number((a.top4 / a.games).toFixed(3)),
          winRate: Number((a.wins / a.games).toFixed(3)),
          playRate: Number((a.games / totalParticipants).toFixed(4)),
          games: a.games,
        },
        coreUnits,
        carryUnits: [a.carryId],
        carryItemsRaw: carryItems,   // item apiName, merge_stats sẽ làm đẹp tên
        keyTraits: a.keyTraits,
      };
    })
    .sort((x, y) => x.stats.avgPlacement - y.stats.avgPlacement);

  await writeFile(
    path.join(ASSET_DIR, 'comps_stats.json'),
    JSON.stringify({ patch: 'riot-aggregate', source: 'riot', sampleMatches: matchIds.size, comps }, null, 2)
  );
  console.log(`✓ ${comps.length} comp (>= ${MIN_GAMES} trận) → comps_stats.json`);
  console.log('  Top 5 theo avgPlacement:');
  comps.slice(0, 5).forEach((c) =>
    console.log(`   ${c.stats.avgPlacement}  ${c.name}  (top4 ${(c.stats.top4Rate * 100) | 0}%, ${c.stats.games}g)`)
  );
  console.log('ℹ carryId/coreUnits là character_id của Riot — map sang apiName champions.json khi nhập vào comps.json.');
}

main().catch((e) => {
  console.error('\n✗ Lỗi:', e.message);
  process.exit(1);
});
