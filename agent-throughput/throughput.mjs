#!/usr/bin/env node
// Agent token throughput for every live local agent terminal in herdr-core.
// Prints JSON: { at, agents: { <address>: { app, model, now, series[], out, in, session } } }
//   now     output tokens in the last 60 s (= tok/min)
//   series  output tokens per minute, oldest first (SERIES_MIN buckets, last = current minute)
//   out/in  session totals (in = fresh input + cache writes, excluding cache reads)
// Claude Code: terminal foreground pid -> ~/.claude/sessions/<pid>.json -> transcript jsonl.
// Codex: the thread named in its terminal title (Codex's state db), else the
//   folder's rollout begun first after the terminal started.
// Antigravity (agy): the conversation SQLite it has open, else the newest one for its folder.
// Transcripts are read incrementally; offsets and recent events are cached.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HOME = os.homedir();
const HC = fs.existsSync(`${HOME}/.local/bin/hc`) ? `${HOME}/.local/bin/hc` : "hc";
const CACHE_DIR = `${HOME}/.cache/herdr-statusbar`;
const CACHE = `${CACHE_DIR}/throughput-cache.json`;
const SERIES_MIN = 15;
const KEEP_MS = SERIES_MIN * 60_000;
const FIRST_READ = 8 * 1024 * 1024; // first look at a big file: only its tail counts for the series
const now = Date.now();

function hc(args) {
  return JSON.parse(execFileSync(HC, [...args, "--json"], { encoding: "utf8", timeout: 4000 }));
}

function loadCache() {
  try { return JSON.parse(fs.readFileSync(CACHE, "utf8")); } catch { return { files: {}, codex: {} }; }
}

// ---------- locating transcripts ----------

let claudeIndex = null; // sessionId -> path, built lazily
function claudeTranscript(sessionId) {
  if (!claudeIndex) {
    claudeIndex = {};
    const root = `${HOME}/.claude/projects`;
    for (const d of safeReaddir(root)) {
      for (const f of safeReaddir(`${root}/${d}`)) {
        if (f.endsWith(".jsonl")) claudeIndex[f.slice(0, -6)] = `${root}/${d}/${f}`;
      }
    }
  }
  return claudeIndex[sessionId] ?? null;
}

function safeReaddir(p) { try { return fs.readdirSync(p); } catch { return []; } }

// Which rollout is this Codex terminal's. Codex titles its terminal
// "<thread name> | <folder>": that thread, in Codex's state database, tells
// apart several Codex in one folder and follows /new. Not named yet: of the
// folder's rollouts begun after the terminal started, the one begun first.
// Cached per pid and title, so a new title (a new thread) looks again.
function codexThreadByName(cwd, title) {
  const bar = (title ?? "").lastIndexOf(" | ");
  const name = bar > 0 ? title.slice(0, bar).trim() : "";
  if (!name) return null;
  const dbs = safeReaddir(`${HOME}/.codex`).filter((f) => /^state_\d+\.sqlite$/.test(f))
    .map((f) => `${HOME}/.codex/${f}`).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  if (!dbs.length) return null;
  const q = (v) => "'" + v.replaceAll("'", "''") + "'";
  try {
    const out = execFileSync("/usr/bin/sqlite3", ["-readonly", dbs[0],
      `select rollout_path from threads where cwd = ${q(cwd)} and name = ${q(name)} and archived = 0 order by updated_at_ms desc limit 1`],
      { encoding: "utf8", timeout: 3000, stdio: ["ignore", "pipe", "ignore"] }).trim();
    return out && fs.existsSync(out) ? out : null;
  } catch { return null; }
}

function codexTranscript(cache, pid, cwd, startedMs, title) {
  const key = `${pid}|${title ?? ""}`;
  const hit = cache.codex[key];
  if (hit && fs.existsSync(hit)) return hit;
  const named = codexThreadByName(cwd, title);
  if (named) { cache.codex[key] = named; return named; }
  // Rollouts live in ~/.codex/sessions/YYYY/MM/DD/; look at today's and yesterday's.
  const days = [0, 1].map((n) => new Date(now - n * 86_400_000));
  const cands = [];
  for (const d of days) {
    const dir = `${HOME}/.codex/sessions/${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}`;
    for (const f of safeReaddir(dir)) {
      // rollout-YYYY-MM-DDTHH-MM-SS-<id>.jsonl, local time the thread began.
      const m = f.match(/^rollout-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-.*\.jsonl$/);
      if (!m) continue;
      const began = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime();
      if (began < startedMs - 1000) continue;
      cands.push({ p: `${dir}/${f}`, began });
    }
  }
  cands.sort((a, b) => a.began - b.began);
  for (const c of cands) {
    try {
      const fd = fs.openSync(c.p, "r");
      // The first line (session_meta) carries the whole system prompt:
      // over 20 KB, so read up to 1 MB and cut at its newline.
      const buf = Buffer.alloc(1024 * 1024);
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      fs.closeSync(fd);
      const end = buf.subarray(0, n).indexOf(10);
      const first = JSON.parse(buf.subarray(0, end < 0 ? n : end).toString("utf8"));
      // Not cached: once the thread is named, the title finds it exactly.
      if (first?.payload?.cwd === cwd) return c.p;
    } catch {}
  }
  return null;
}

// ---------- incremental parsing ----------

function update(cache, file, kind) {
  let st;
  try { st = fs.statSync(file); } catch { return null; }
  let e = cache.files[file];
  if (!e || st.size < e.offset) {
    e = { kind, offset: Math.max(0, st.size - FIRST_READ), partialTotals: st.size > FIRST_READ, midLine: st.size > FIRST_READ,
          out: 0, in: 0, model: null, events: [], seen: {}, last: null };
    cache.files[file] = e;
  }
  if (st.size > e.offset) {
    const fd = fs.openSync(file, "r");
    const len = st.size - e.offset;
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, e.offset);
    fs.closeSync(fd);
    const text = buf.toString("utf8");
    const end = text.lastIndexOf("\n");
    if (end >= 0) {
      const lines = text.slice(0, end).split("\n");
      // A tail read starts mid-line: drop the first fragment.
      const start = e.midLine ? 1 : 0;
      e.midLine = false;
      for (let i = start; i < lines.length; i++) {
        if (!lines[i]) continue;
        let d; try { d = JSON.parse(lines[i]); } catch { continue; }
        (kind === "claude" ? claudeLine : codexLine)(e, d);
      }
      e.offset += Buffer.byteLength(text.slice(0, end + 1), "utf8");
    }
  }
  e.events = e.events.filter((x) => x[0] >= now - KEEP_MS);
  e.touched = now;
  return e;
}

function claudeLine(e, d) {
  if (d.type !== "assistant" || !d.message?.usage) return;
  const id = d.message.id;
  const u = d.message.usage;
  const t = Date.parse(d.timestamp) || now;
  const out = u.output_tokens ?? 0;
  const inp = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
  if (d.message.model && d.message.model !== "<synthetic>") e.model = d.message.model;
  // One message is written once per content block with the same usage; count it once,
  // and only its growth if a later copy reports more.
  const prev = e.seen[id];
  if (prev) {
    const dOut = Math.max(0, out - prev[0]), dIn = Math.max(0, inp - prev[1]);
    if (dOut || dIn) { e.seen[id] = [out, inp, t]; e.out += dOut; e.in += dIn; if (dOut) e.events.push([t, dOut]); }
    return;
  }
  e.seen[id] = [out, inp, t];
  e.out += out; e.in += inp;
  if (out) e.events.push([t, out]);
  // Keep the dedupe table small.
  const ids = Object.keys(e.seen);
  if (ids.length > 400) for (const k of ids.slice(0, ids.length - 200)) delete e.seen[k];
}

function codexLine(e, d) {
  if (d.type === "turn_context" && d.payload?.model) e.model = d.payload.model;
  if (d.type !== "event_msg" || d.payload?.type !== "token_count") return;
  const tot = d.payload.info?.total_token_usage;
  if (!tot) return;
  const t = Date.parse(d.timestamp) || now;
  const out = tot.output_tokens ?? 0;
  const inp = Math.max(0, (tot.input_tokens ?? 0) - (tot.cached_input_tokens ?? 0));
  const last = e.last ?? (e.partialTotals ? [out, inp] : [0, 0]); // a tail read starts from its first total
  const dOut = Math.max(0, out - last[0]);
  e.last = [out, inp];
  e.out = out; e.in = inp; e.partialTotals = false;
  if (dOut) e.events.push([t, dOut]);
}

// ---------- Antigravity CLI (agy) ----------
// Each conversation is a SQLite file ~/.gemini/antigravity-cli/conversations/<id>.db; every
// model step's `metadata` protobuf carries 1 = created {sec, nanos}, 8 = finished, and
// 9 = usage {1: input, 2: cached input, 3: output (incl. thinking)}.

const AGY = `${HOME}/.gemini/antigravity-cli`;

function sqlite(db, sql) {
  const run = (target, flags = []) => execFileSync("/usr/bin/sqlite3", [...flags, "-separator", "|", target, sql],
    { encoding: "utf8", timeout: 4000, maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
  // Read-only needs the WAL's -shm file, which exists only while something has the file open.
  // Without it there is no live WAL either, so the file can be read as immutable: never written.
  let out;
  try { out = run(db, ["-readonly"]); } catch { out = run(`file:${encodeURI(db)}?immutable=1`); }
  return out.split("\n").filter(Boolean).map((l) => l.split("|"));
}

function agyConversation(pid, cwd) {
  // Best: the conversation file the process has open.
  try {
    const out = execFileSync("/usr/sbin/lsof", ["-Fn", "-p", String(pid)], { encoding: "utf8", timeout: 3000, stdio: ["ignore", "pipe", "ignore"] });
    const m = out.match(/\nn(\S+\/antigravity-cli\/conversations\/[^/\n]+\.db)\n/);
    if (m) return m[1];
  } catch {}
  // Else: of the conversations in this folder, the one written last.
  try {
    const uri = "file://" + cwd.split("/").map(encodeURIComponent).join("/");
    const ids = sqlite(`${AGY}/conversation_summaries.db`,
      `select conversation_id from conversation_summaries where workspace_uris like '%"${uri.replace(/'/g, "''")}"%'`).map((r) => r[0]);
    let best = null, bestM = 0;
    for (const id of ids) {
      const p = `${AGY}/conversations/${id}.db`;
      try { const m = fs.statSync(p).mtimeMs; if (m > bestM) { best = p; bestM = m; } } catch {}
    }
    return best;
  } catch { return null; }
}

function pbFields(buf) {
  const out = {}; let i = 0;
  const varint = () => { let r = 0, mul = 1, c; do { c = buf[i++]; r += (c & 0x7f) * mul; mul *= 128; } while (c & 0x80); return r; };
  while (i < buf.length) {
    const key = varint(), f = Math.floor(key / 8), w = key & 7;
    if (w === 0) out[f] = varint();
    else if (w === 2) { const l = varint(); out[f] = buf.subarray(i, i + l); i += l; }
    else if (w === 1) i += 8; else if (w === 5) i += 4; else break;
  }
  return out;
}

function updateAgy(cache, db) {
  let st; try { st = fs.statSync(db); } catch { return null; }
  let e = cache.files[db];
  let first = false;
  if (!e) { e = cache.files[db] = { kind: "agy", out: 0, in: 0, model: null, events: [], done: [], maxIdx: -1 }; first = true; }
  const walM = (() => { try { return fs.statSync(`${db}-wal`).mtimeMs; } catch { return 0; } })();
  const m = Math.max(st.mtimeMs, walM);
  if (m !== e.mtime) {
    // Only finished steps (status 3) count; unfinished ones are looked at again next time.
    const done = new Set(e.done);
    // Model replies are step_type 15. A long conversation seen for the first time: its last 400 replies.
    const rows = first
      ? sqlite(db, "select idx, hex(metadata) from (select idx, metadata from steps where step_type = 15 and status = 3 order by idx desc limit 400) order by idx")
      : sqlite(db, `select idx, hex(metadata) from steps where step_type = 15 and status = 3 and idx > ${Math.max(-1, e.maxIdx - 50)}`);
    if (first) e.partialTotals = rows.length >= 400;
    for (const [idxS, hex] of rows) {
      const idx = Number(idxS);
      if (done.has(idx) || !hex) continue;
      done.add(idx); e.maxIdx = Math.max(e.maxIdx, idx);
      const f = pbFields(Buffer.from(hex, "hex"));
      if (!f[9]) continue;
      const u = pbFields(f[9]);
      const ts = f[8] ?? f[7] ?? f[1];
      const t = ts ? pbFields(ts)[1] * 1000 : now;
      const out = u[3] ?? 0, inp = Math.max(0, (u[1] ?? 0));
      e.out += out; e.in += inp;
      if (out) e.events.push([t, out]);
    }
    e.done = [...done].sort((a, b) => a - b).slice(-200);
    if (!e.model) {
      try {
        const r = sqlite(db, "select hex(data) from gen_metadata order by idx desc limit 1")[0];
        const txt = r ? Buffer.from(r[0], "hex").toString("latin1") : "";
        e.model = txt.match(/(gemini-[\w.-]+|claude-[\w.-]+|gpt-[\w.-]+)/)?.[1] ?? null;
      } catch {}
    }
    e.mtime = m;
  }
  e.events = e.events.filter((x) => x[0] >= now - KEEP_MS);
  e.touched = now;
  return e;
}

// ---------- main ----------

const cache = loadCache();
const result = { at: now, agents: {} };
let list = [];
try { list = hc(["ls"]).terminals ?? []; } catch (err) {
  console.log(JSON.stringify({ at: now, error: String(err.message ?? err), agents: {} }));
  process.exit(0);
}

const curMin = Math.floor(now / 60_000);
for (const t of list) {
  if (t.state !== "live" || !t.status || t.address.includes("/")) continue;
  let info;
  try { info = hc(["get", t.address]); } catch { continue; }
  const fg = info.foreground;
  if (!fg?.pid) continue;
  const app = info.status?.app ?? t.agent ?? "";
  let file = null, kind = null;
  if (/claude/i.test(app) || /claude/i.test(fg.name ?? "")) {
    try {
      const s = JSON.parse(fs.readFileSync(`${HOME}/.claude/sessions/${fg.pid}.json`, "utf8"));
      file = claudeTranscript(s.sessionId); kind = "claude";
    } catch {}
  } else if (/codex/i.test(app) || /codex/i.test(fg.name ?? "")) {
    file = codexTranscript(cache, fg.pid, fg.cwd, info.created_ms ?? 0, info.title ?? t.title); kind = "codex";
  } else if (/antigravity|^agy$/i.test(app) || /^agy$/i.test(fg.name ?? "")) {
    file = agyConversation(fg.pid, fg.cwd); kind = "agy";
  }
  if (!file) { result.agents[t.address] = { app, supported: false }; continue; }
  let e = null;
  try { e = kind === "agy" ? updateAgy(cache, file) : update(cache, file, kind); } catch {}
  if (!e) continue;
  const series = new Array(SERIES_MIN).fill(0);
  let last60 = 0;
  for (const [ts, n] of e.events) {
    const i = SERIES_MIN - 1 - (curMin - Math.floor(ts / 60_000));
    if (i >= 0 && i < SERIES_MIN) series[i] += n;
    if (ts >= now - 60_000) last60 += n;
  }
  result.agents[t.address] = {
    app, supported: true, kind, model: e.model, now: last60, series,
    out: e.out, in: e.in, partial: !!e.partialTotals,
  };
}

// Forget files not looked at for a day.
for (const [f, e] of Object.entries(cache.files)) if (now - (e.touched ?? 0) > 86_400_000) delete cache.files[f];
try {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const tmp = `${CACHE}.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(cache));
  fs.renameSync(tmp, CACHE);
} catch {}

console.log(JSON.stringify(result));
