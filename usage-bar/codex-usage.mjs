#!/usr/bin/env node
// Prints Codex plan usage like claude-usage.mjs: {ok, plan, five, week, at}.
// Codex writes its rate limits into every token_count event of its session
// logs (~/.codex/sessions/**/rollout-*.jsonl); the newest one is the answer.
import { readdirSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const root = join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "sessions");

// Newest rollout files first (walks only the last few day folders).
function recentFiles(limit = 12) {
  const out = [];
  const dirs = (p) => { try { return readdirSync(p).filter((n) => /^\d+$/.test(n)).sort().reverse(); } catch { return []; } };
  for (const y of dirs(root)) for (const m of dirs(join(root, y))) for (const d of dirs(join(root, y, m))) {
    const dir = join(root, y, m, d);
    let names = [];
    try { names = readdirSync(dir).filter((n) => n.endsWith(".jsonl")); } catch {}
    for (const n of names) { try { out.push({ p: join(dir, n), t: statSync(join(dir, n)).mtimeMs }); } catch {} }
    if (out.length >= limit * 3) break;
  }
  return out.sort((a, b) => b.t - a.t).slice(0, limit);
}

// The last token_count line with rate limits, from the file's tail.
function lastLimits(path) {
  const fd = openSync(path, "r");
  try {
    const size = statSync(path).size;
    const len = Math.min(size, 2 << 20);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    const lines = buf.toString("utf8").split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      const l = lines[i];
      if (!l.includes('"token_count"') || !l.includes('"rate_limits"')) continue;
      try {
        const o = JSON.parse(l);
        const rl = o.payload?.rate_limits;
        if (rl?.primary || rl?.secondary) return { rl, at: Date.parse(o.timestamp) || 0 };
      } catch {}
    }
  } finally { closeSync(fd); }
  return null;
}

let best = null;
for (const f of recentFiles()) {
  try { const r = lastLimits(f.p); if (r && (!best || r.at > best.at)) best = r; } catch {}
}

const win = (w) => {
  if (!w || !Number.isFinite(w.used_percent)) return null;
  const reset = Number.isFinite(w.resets_at) ? w.resets_at * 1000 : null;
  // A window that has reset since we last heard is empty again.
  const pct = reset && reset < Date.now() ? 0 : Math.round(w.used_percent);
  return { pct, reset, minutes: w.window_minutes ?? null };
};

process.stdout.write(JSON.stringify(best
  ? { ok: true, plan: best.rl.plan_type ?? null, five: win(best.rl.primary), week: win(best.rl.secondary), at: best.at }
  : { ok: false }));
