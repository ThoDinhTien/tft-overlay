#!/usr/bin/env node
/**
 * Tải dữ liệu TFT Set HIỆN TẠI từ Community Dragon và sinh ra:
 *   - app/src/main/assets/champions.json
 *   - app/src/main/assets/traits.json
 *   - app/src/main/assets/champions/<apiName>.png   (icon vuông từng tướng)
 *
 * Chạy lại file này mỗi khi Riot ra Set/patch mới để app tự cập nhật.
 *   node scripts/fetch_assets.mjs
 *
 * KHÔNG đụng tới comps.json — file đó là meta đội hình do team tự cập nhật tay.
 */
import { writeFile, mkdir } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';

const CDRAGON = 'https://raw.communitydragon.org/latest';
const DATA_URL = `${CDRAGON}/cdragon/tft/en_us.json`;
const GAME_BASE = `${CDRAGON}/game/`;

const ROOT = path.resolve(import.meta.dirname, '..');
const ASSET_DIR = path.join(ROOT, 'data');
const ICON_DIR = path.join(ASSET_DIR, 'champions');

function iconUrl(rawPath) {
  if (!rawPath) return null;
  // "ASSETS/.../X.tex" -> game/assets/.../x.png
  const p = rawPath.toLowerCase().replace(/\.(tex|dds)$/, '.png');
  return GAME_BASE + p;
}

async function download(url, dest) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  await pipeline(res.body, createWriteStream(dest));
}

function pickLatestSet(json) {
  // Ưu tiên setData (mảng), fallback sang sets (object keyed by số).
  if (Array.isArray(json.setData) && json.setData.length) {
    // Lấy mutator/number lớn nhất.
    return json.setData
      .filter((s) => s.champions?.length)
      .sort((a, b) => (Number(b.number) || 0) - (Number(a.number) || 0))[0];
  }
  const keys = Object.keys(json.sets || {})
    .map(Number)
    .filter((n) => !Number.isNaN(n))
    .sort((a, b) => b - a);
  return json.sets[keys[0]];
}

function traitBreakpoints(trait) {
  const mins = (trait.effects || [])
    .map((e) => e.minUnits)
    .filter((n) => Number.isFinite(n));
  return [...new Set(mins)].sort((a, b) => a - b);
}

async function main() {
  console.log('→ Tải dữ liệu TFT từ Community Dragon…');
  const json = await (await fetch(DATA_URL)).json();
  const set = pickLatestSet(json);
  if (!set) throw new Error('Không tìm thấy Set nào có champions');
  console.log(`→ Set: ${set.name || set.number} (${set.champions.length} tướng)`);

  await mkdir(ICON_DIR, { recursive: true });

  // Chỉ lấy quân chơi được (cost 1..5), bỏ summon/quái.
  const champions = [];
  let ok = 0, fail = 0;
  for (const c of set.champions) {
    if (!c.cost || c.cost < 1 || c.cost > 5) continue;
    const iconAsset = `${c.apiName}.png`;
    const url = iconUrl(c.squareIcon || c.tileIcon || c.icon);
    if (url) {
      try {
        await download(url, path.join(ICON_DIR, iconAsset));
        ok++;
      } catch (e) {
        fail++;
        console.warn(`  ⚠ icon lỗi ${c.apiName}: ${e.message}`);
      }
    }
    champions.push({
      apiName: c.apiName,
      name: c.name,
      cost: c.cost,
      traits: c.traits || [],
      iconAsset,
    });
  }

  const traits = (set.traits || []).map((t) => ({
    apiName: t.apiName,
    name: t.name,
    breakpoints: traitBreakpoints(t),
  }));

  await writeFile(
    path.join(ASSET_DIR, 'champions.json'),
    JSON.stringify({ set: set.name || String(set.number), champions }, null, 2)
  );
  await writeFile(
    path.join(ASSET_DIR, 'traits.json'),
    JSON.stringify({ traits }, null, 2)
  );

  console.log(`✓ ${champions.length} tướng, ${traits.length} tộc-hệ. Icon: ${ok} ok / ${fail} lỗi.`);
  console.log('✓ Ghi champions.json + traits.json');
  console.log('ℹ Nhớ cập nhật comps.json (meta đội hình) theo patch hiện tại.');
}

main().catch((e) => {
  console.error('✗ Lỗi:', e.message);
  process.exit(1);
});
