#!/usr/bin/env node
// Prints Antigravity CLI (agy) model quota: {ok, plan, models: [{id, name, pct, reset}], at}.
// plan: the Google subscription the quota comes from ("Google AI Pro"), else the tier's name.
// Asks the same quota endpoint agy itself uses, with agy's own saved sign-in
// (~/.gemini/antigravity-cli/antigravity-oauth-token). agy refreshes that
// token while it runs; when it has expired, the last answer is shown, cached
// for CACHE_SECONDS like claude-usage.mjs.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CACHE_SECONDS = 300;
const cacheDir = join(homedir(), ".cache", "herdr-statusbar");
const cacheFile = join(cacheDir, "agy-usage.json");
const AGY = join(homedir(), ".gemini", "antigravity-cli");

function readCache() { try { return JSON.parse(readFileSync(cacheFile, "utf8")); } catch { return null; } }

// The subscription: loadCodeAssist names the paid tier ("Google AI Pro"),
// else the current one. null when it doesn't answer.
async function plan(token) {
  try {
    const res = await fetch("https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "User-Agent": "antigravity" },
      body: JSON.stringify({ metadata: { ideType: "ANTIGRAVITY", pluginType: "GEMINI" } }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    const body = await res.json();
    return body.paidTier?.name ?? body.currentTier?.name ?? null;
  } catch { return null; }
}

async function query() {
  let token;
  try {
    const saved = JSON.parse(readFileSync(join(AGY, "antigravity-oauth-token"), "utf8")).token;
    if (!saved?.access_token || (saved.expiry && Date.parse(saved.expiry) < Date.now())) return null;
    token = saved.access_token;
  } catch { return null; }
  try {
    const res = await fetch("https://cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "User-Agent": "antigravity" },
      body: "{}",
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return null;
    const body = await res.json();
    // The models agy's picker offers: its Gemini tiers, then the agent list.
    const tiers = body.tieredModelIds ?? {};
    const picker = (body.agentModelSorts ?? []).flatMap((s) => (s.groups ?? []).flatMap((g) => g.modelIds ?? []));
    const ids = [...new Set([...(tiers.flash ?? []), ...(tiers.pro ?? []), ...picker])];
    const tierName = (id) => /flash/.test(id) ? "Gemini " + (id.match(/\d+(\.\d+)?/)?.[0] ?? "") + " Flash" : id;
    const models = ids
      .map((id) => [id, body.models?.[id]])
      .filter(([, m]) => m?.quotaInfo)
      .map(([id, m]) => {
        const left = Number.isFinite(m.quotaInfo.remainingFraction) ? m.quotaInfo.remainingFraction : 1;
        return { id, name: m.displayName ?? tierName(id), pct: Math.round((1 - left) * 100), reset: Date.parse(m.quotaInfo.resetTime) || null };
      });
    return { ok: true, plan: await plan(token), models, at: Date.now() };
  } catch { return null; }
}

const cached = readCache();
if (!process.argv.includes("--force") && cached && Date.now() - cached.at < CACHE_SECONDS * 1000) {
  process.stdout.write(JSON.stringify(cached.data));
} else {
  const data = await query();
  if (data) { mkdirSync(cacheDir, { recursive: true }); writeFileSync(cacheFile, JSON.stringify({ at: Date.now(), data })); }
  process.stdout.write(JSON.stringify(data ?? (cached?.data ? { ...cached.data, stale: true } : { ok: false })));
}
