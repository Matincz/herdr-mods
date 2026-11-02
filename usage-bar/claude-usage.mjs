#!/usr/bin/env node
// Prints Claude plan usage for herdr's tab bar, e.g. "◷5h 23% ▦7d 41%".
// Cached for CACHE_SECONDS so the tab bar can poll cheaply.
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Where Claude Code gets installed: its own installer, Homebrew (both), npm.
process.env.PATH = [join(homedir(), ".local/bin"), join(homedir(), ".claude/local"), "/opt/homebrew/bin", "/usr/local/bin",
  "/usr/bin", "/bin", "/usr/sbin", "/sbin", process.env.PATH ?? ""].join(":");
process.env.USER ??= homedir().split("/").pop();

const CACHE_SECONDS = 300;
const cacheDir = join(homedir(), ".cache", "herdr-statusbar");
const cacheFile = join(cacheDir, "claude-usage-raw.json");

function fmt(body) {
  const rl = body?.rate_limits;
  if (!body?.rate_limits_available || !rl) return { ok: false };
  const w = x => x && Number.isFinite(x.utilization)
    ? { pct: Math.round(x.utilization), reset: typeof x.resets_at === "string" ? Date.parse(x.resets_at) : (Number.isFinite(x.resets_at) ? x.resets_at * 1000 : null) }
    : null;
  return { ok: true, plan: body.subscription_type ?? null, five: w(rl.five_hour), week: w(rl.seven_day) };
}

function readCache() {
  try { return JSON.parse(readFileSync(cacheFile, "utf8")); } catch { return null; }
}

function query() {
  return new Promise(resolve => {
    const child = spawn("claude", ["-p", "--input-format", "stream-json", "--output-format", "stream-json",
      "--verbose", "--no-session-persistence", "--strict-mcp-config", "--settings", '{"disableAllHooks":true}'],
      { stdio: ["pipe", "pipe", "ignore"], detached: true, cwd: homedir() });
    let buf = "", stage = "init", done = false;
    const finish = v => {
      if (done) return; done = true; clearTimeout(t);
      try { process.kill(-child.pid, "SIGKILL"); } catch {}
      resolve(v);
    };
    const t = setTimeout(() => finish(null), 20000);
    const send = (id, request) => child.stdin.write(JSON.stringify({ type: "control_request", request_id: id, request }) + "\n");
    child.on("error", () => finish(null));
    child.stdin.on("error", () => {});
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", c => {
      buf += c; let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        let m; try { m = JSON.parse(line); } catch { continue; }
        if (m?.type !== "control_response" || m.response?.request_id !== stage) continue;
        if (m.response.subtype !== "success") return finish(null);
        if (stage === "init") { stage = "usage"; send("usage", { subtype: "get_usage", skip_behaviors: true }); }
        else return finish(m.response.response);
      }
    });
    send("init", { subtype: "initialize" });
  });
}

const cached = readCache();
if (!process.argv.includes("--force") && cached && Date.now() - cached.at < CACHE_SECONDS * 1000) {
  process.stdout.write(JSON.stringify(cached.data));
} else {
  const body = await query();
  const data = body ? fmt(body) : (cached?.data ?? { ok: false });
  if (body) { mkdirSync(cacheDir, { recursive: true }); writeFileSync(cacheFile, JSON.stringify({ at: Date.now(), data })); }
  process.stdout.write(JSON.stringify(data));
}
