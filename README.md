# TFT Comp Stats Aggregator

A personal, non-commercial Teamfight Tactics **statistics tool**. It aggregates
anonymized ranked match data from top-ladder players (via the Riot API) to compute
aggregate performance metrics per team composition — **average placement, top-4
rate, win rate, play rate**, plus the items challenger players most often build on
each carry. The output is a local dataset describing which compositions are strong
on the current set/patch.

The tool is **read-only** against the Riot API, runs on a schedule (not
per-user-request), caches results locally, and does **not** modify, automate, or
interact with live games in any way.

## How it works

```bash
# 1) Static set data (champions / traits) from Community Dragon
node scripts/fetch_assets.mjs

# 2) Compute real comp stats from ranked matches (VN: PLATFORM=vn2 REGION=sea)
RIOT_API_KEY=RGAPI-xxxx PLATFORM=vn2 REGION=sea node scripts/aggregate_comps.mjs
node scripts/merge_stats.mjs    # → data/comps.json (top comps + stats + items)
```

Endpoints used: `TFT-LEAGUE-V1` (challenger ladder → PUUIDs) and `TFT-MATCH-V1`
(match ids + match detail). For each participant a "composition signature" (its two
strongest active traits + primary carry) is derived and placements are aggregated
into per-composition statistics. Only aggregated, non-identifying numbers are
stored — no per-player data. All calls respect the documented rate limits with
client-side throttling and 429/Retry-After handling. No write operations, no
gameplay automation, no real-time per-user querying.

## Scheduled refresh

`scripts/update_meta.sh` + a systemd user timer (`tft-meta.timer`, weekly) re-run
aggregate→merge. The key lives in `~/.config/tft-overlay/riot.env` (chmod 600); if
empty, the run is skipped cleanly. Logs: `~/.claude/cron/logs/tft-meta.log`.

## Output data (`data/`)

| File | Contents |
|---|---|
| `champions.json` / `traits.json` | Current set data (Community Dragon) |
| `comps_stats.json` | All aggregated compositions with raw stats |
| `comps.json` | Top compositions: `stats` (avgPlacement / top4 / winRate) + common carry items |

## Layout

| Path | Purpose |
|---|---|
| `scripts/aggregate_comps.mjs` | Riot match-data aggregation (the API client) |
| `scripts/merge_stats.mjs` | Build `data/comps.json` from aggregated stats |
| `scripts/fetch_assets.mjs` | Static set data from Community Dragon |
| `scripts/update_meta.sh` | Scheduled refresh wrapper |
| `data/` | Generated datasets |

---

*This project isn't endorsed by Riot Games and doesn't reflect the views or opinions
of Riot Games or anyone officially involved in producing or managing Riot Games
properties. Riot Games, and all associated properties are trademarks or registered
trademarks of Riot Games, Inc.*
