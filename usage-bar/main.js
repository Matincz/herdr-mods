import { View, div } from "gpui-kit";
import { h_flex } from "gpui-base";
import { exec, home, theme, setShared, openOverlay } from "herdr";

// A slim bar: Claude plan usage (5h / 7d windows), CPU, memory, battery, clock.
const DIR = () => `${home()}/.config/herdr-app/mods/usage-bar`;
// node wherever it is: Homebrew (Apple silicon, Intel), PATH, else the login
// shell's PATH (nvm, volta). A GUI app's own PATH is the system's only.
const RUN_NODE = 'for n in /opt/homebrew/bin/node /usr/local/bin/node "$(command -v node)"; do [ -n "$n" ] && [ -x "$n" ] && exec "$n" "$@"; done; n=$("${SHELL:-/bin/zsh}" -lc "command -v node" 2>/dev/null); [ -n "$n" ] && exec "$n" "$@"; echo "node not found" >&2; exit 127';
const node = (args) => exec("/bin/sh", ["-c", RUN_NODE, "node", ...args]);
const TP_SCRIPT = () => `${home()}/.config/herdr-app/mods/agent-throughput/throughput.mjs`;

function fmt(n) {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}k`;
  return String(Math.round(n ?? 0));
}

function until(ms) {
  if (!ms) return "";
  let m = Math.max(0, Math.round((ms - Date.now()) / 60000));
  const d = Math.floor(m / 1440); m -= d * 1440;
  const h = Math.floor(m / 60); m -= h * 60;
  return d ? `${d}d${h}h` : h ? `${h}h${m}m` : `${m}m`;
}

export default class UsageBar extends View {
  init(_props, cx) {
    this.claude = null;
    this.sys = null;
    this.now = new Date();
    this.loading = false;
    this.refreshClaude(cx, false);
    this.refreshSys(cx);
    this.tp = null;
    this.refreshThroughput(cx);
    cx.timer.every(5_000, (cx) => this.refreshThroughput(cx));
    cx.timer.every(60_000, (cx) => this.refreshClaude(cx, false)); // script caches 5 min
    cx.timer.every(5_000, (cx) => this.refreshSys(cx));
    cx.timer.every(30_000, (cx) => { this.now = new Date(); cx.notify(); });
  }

  refreshClaude(cx, force) {
    if (this.loading) return;
    this.loading = true;
    cx.spawn(async (cx) => {
      try {
        const args = [`${DIR()}/claude-usage.mjs`];
        if (force) args.push("--force");
        const r = await node(args);
        this.claude = JSON.parse(r.stdout);
      } catch { this.claude = this.claude ?? { ok: false }; }
      this.loading = false;
      cx.notify();
    });
  }

  refreshSys(cx) {
    cx.spawn(async (cx) => {
      try { this.sys = JSON.parse((await exec("/bin/sh", [`${DIR()}/sysinfo.sh`])).stdout); } catch {}
      this.now = new Date();
      cx.notify();
    });
  }

  // Agent token throughput (agent-throughput mod's script); shared so its popup shows the same.
  refreshThroughput(cx) {
    if (this.tpBusy) return;
    this.tpBusy = true;
    cx.spawn(async (cx) => {
      try {
        const data = JSON.parse((await node([TP_SCRIPT()])).stdout);
        const list = Object.values(data.agents ?? {}).filter((a) => a.supported);
        const series = new Array(15).fill(0);
        for (const a of list) a.series.forEach((v, i) => (series[i] += v));
        const next = { now: list.reduce((s, a) => s + a.now, 0), series, count: list.length };
        setShared("agent.throughput", data);
        this.tp = next;
      } catch {}
      this.tpBusy = false;
      cx.notify();
    });
  }

  throughput(t) {
    const tp = this.tp;
    const max = Math.max(1, ...(tp?.series ?? [0]));
    return h_flex().id("tp").gap(6).items_center().cursor_pointer()
      .tooltip("Agent 吞吐量：所有 agent 每分钟输出 token · 点击查看每个 agent")
      .on_click(() => openOverlay({ mod: "agent-throughput", kind: "popup", width: 400, height: 360 }))
      .child(div().text_color(tp?.now ? t.working : t.dim).child("⚡"))
      .child(h_flex().w(45).h(12).gap(1).items_end().children((tp?.series ?? new Array(15).fill(0)).map((v) =>
        div().w(2).rounded(1).h(v > 0 ? Math.max(1.5, 12 * v / max) : 1).bg(v > 0 ? t.accent : t.raised))))
      .child(div().text_color(tp?.now ? t.foreground : t.muted).child(tp ? `${fmt(tp.now)} tok/m` : "–"));
  }

  level(t, pct) {
    return pct >= 85 ? t.blocked : pct >= 60 ? t.working : t.accent;
  }

  meter(t, id, label, pct, extra) {
    const p = Math.max(0, Math.min(100, pct ?? 0));
    return h_flex().id(id).gap(6).items_center()
      .child(div().text_color(t.dim).child(label))
      .child(div().w(46).h(5).rounded(3).bg(t.raised)
        .child(div().h_full().rounded(3).bg(this.level(t, p)).w(46 * p / 100)))
      .child(div().text_color(t.foreground).child(pct == null ? "–" : `${pct}%`))
      .when(Boolean(extra), (el) => el.child(div().text_color(t.dim).child(extra)));
  }

  render(cx) {
    const t = theme();
    const c = this.claude;
    const s = this.sys;
    const sep = () => div().w(1).h(12).bg(t.border);

    const claude = h_flex().id("claude").gap(12).items_center().cursor_pointer()
      .tooltip("Claude 套餐用量 · 点击立即刷新")
      .on_click((_e, cx) => this.refreshClaude(cx, true))
      .child(div().text_color(t.accent).font_semibold().child(this.loading && !c ? "✻ …" : "✻ Claude"));
    if (c?.ok) {
      claude.child(this.meter(t, "c5", "5h", c.five?.pct, c.five?.reset ? `↻${until(c.five.reset)}` : ""))
            .child(this.meter(t, "c7", "7d", c.week?.pct, c.week?.reset ? `↻${until(c.week.reset)}` : ""));
    } else if (c) {
      claude.child(div().text_color(t.dim).child("不可用"));
    }

    const hh = String(this.now.getHours()).padStart(2, "0");
    const mm = String(this.now.getMinutes()).padStart(2, "0");

    return h_flex().id("root").size_full().px(14).gap(14).items_center()
      .bg(t.chrome).border_t(1).border_color(t.border).text_size(11.5).text_color(t.muted)
      .child(claude)
      .child(sep())
      .child(this.throughput(t))
      .child(div().flex_1())
      .when(Boolean(s), (el) => el
        .child(this.meter(t, "cpu", "CPU", s.cpu))
        .child(this.meter(t, "mem", "MEM", s.mem))
        .when(s.batt != null, (el) => el.child(this.meter(t, "bat", s.ac ? "⚡" : "🔋", s.batt)))
        .child(sep()))
      .child(div().text_color(t.foreground).child(`${this.now.getMonth() + 1}/${this.now.getDate()} ${hh}:${mm}`));
  }
}
