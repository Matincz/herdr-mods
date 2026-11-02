import { View, div, svg, image } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { agents, theme, shared, setShared, exec, home, run, props, closeOverlay } from "herdr";

// Agent throughput: output tokens per minute for each agent, from its session transcript
// (Claude Code, Codex). Data comes from throughput.mjs; the usage-bar polls it and shares
// it as "agent.throughput". Opened as a popup from the usage-bar, or put it in a layout block.
export const KEY = "agent.throughput";
export const SCRIPT = () => `${home()}/.config/herdr-app/mods/agent-throughput/throughput.mjs`;
// node wherever it is: Homebrew (Apple silicon, Intel), PATH, else the login
// shell's PATH (nvm, volta). A GUI app's own PATH is the system's only.
const RUN_NODE = 'for n in /opt/homebrew/bin/node /usr/local/bin/node "$(command -v node)"; do [ -n "$n" ] && [ -x "$n" ] && exec "$n" "$@"; done; n=$("${SHELL:-/bin/zsh}" -lc "command -v node" 2>/dev/null); [ -n "$n" ] && exec "$n" "$@"; echo "node not found" >&2; exit 127';
const node = (args) => exec("/bin/sh", ["-c", RUN_NODE, "node", ...args]);

export function fmt(n) {
  if (n == null) return "–";
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}k`;
  return String(Math.round(n));
}

/** Polls the script once and shares the result. Returns the data. */
export async function poll() {
  const r = await node([SCRIPT()]);
  const data = JSON.parse(r.stdout);
  setShared(KEY, data);
  return data;
}

/** Bars, oldest left; `w`/`h` the whole box. */
export function sparkline(t, id, series, { w = 60, h = 14, color } = {}) {
  const max = Math.max(1, ...series);
  const gap = 1;
  const bw = Math.max(1, (w - gap * (series.length - 1)) / series.length);
  return h_flex().id(id).w(w).h(h).gap(gap).items_end().flex_none().children(
    series.map((v, i) => div().w(bw).rounded(1)
      .h(v > 0 ? Math.max(1.5, (h * v) / max) : 1)
      .bg(v > 0 ? (color ?? t.accent) : t.raised)
      .when(i === series.length - 1 && v > 0, (el) => el.opacity(0.75))));
}

export function totals(data) {
  const list = Object.values(data?.agents ?? {}).filter((a) => a.supported);
  const n = list[0]?.series?.length ?? 15;
  const series = new Array(n).fill(0);
  for (const a of list) a.series.forEach((v, i) => (series[i] += v));
  return { now: list.reduce((s, a) => s + a.now, 0), series, out: list.reduce((s, a) => s + a.out, 0), count: list.length };
}

export default class AgentThroughput extends View {
  init(_props, cx) {
    // Poll ourselves only when nobody else keeps the shared data fresh.
    const tick = (cx) => {
      const d = shared(KEY);
      if (d && Date.now() - d.at < 12_000) return;
      cx.spawn(async (cx) => { try { await poll(); } catch {} cx.notify(); });
    };
    tick(cx);
    cx.timer.every(5_000, tick);
  }

  render() {
    const t = theme();
    const data = shared(KEY);
    const overlay = props()?.overlay;
    const tot = totals(data);
    const statusColor = (s) => t[s] ?? t.dim;

    const head = h_flex().gap(10).items_center().px(12).pt(10).pb(8).border_b(1).border_color(t.border)
      .child(div().text_color(t.accent).font_semibold().child("⚡ Agent 吞吐量"))
      .child(div().flex_1())
      .child(div().text_color(t.foreground).font_semibold().child(`${fmt(tot.now)} tok/min`))
      .child(sparkline(t, "tot-spark", tot.series, { w: 75, h: 14 }));

    const rows = agents().map((a) => {
      const d = data?.agents?.[a.address];
      const p = a.program;
      const icon = p?.icon ? (p.tint ? svg(p.icon).size(15).text_color(t.muted) : image(p.icon).size(15)) : div().size(15);
      const active = d?.supported && d.now > 0;
      const right = !d ? div().text_color(t.dim).child(data ? "—" : "…")
        : !d.supported ? div().text_color(t.dim).child("不支持")
        : h_flex().gap(10).items_center()
            .child(sparkline(t, `sp-${a.address}`, d.series, { w: 60, h: 14, color: statusColor(a.status) }))
            .child(v_flex().w(64).items_end()
              .child(div().text_color(active ? t.foreground : t.muted).font_semibold().child(`${fmt(d.now)}/m`))
              .child(div().text_size(10.5).text_color(t.dim).child(`Σ ${d.partial ? "≥" : ""}${fmt(d.out)}`)));
      return h_flex().id(`row-${a.address}`).px(12).py(6).gap(10).items_center().cursor_pointer()
        .hover((s) => s.bg(t.hover))
        .on_click(() => { if (overlay) closeOverlay(overlay); run("agent.focus", { terminal: a.address }); })
        .child(div().size(7).rounded(4).flex_none().bg(statusColor(a.status)))
        .child(icon)
        .child(v_flex().flex_1().min_w(0)
          .child(div().truncate().text_color(t.foreground).child(a.title || p?.name || a.address))
          .child(div().truncate().text_size(10.5).text_color(t.dim)
            .child(`${a.space_name} / ${a.tab_name} · ${a.address}${d?.model ? ` · ${d.model.replace(/^claude-/, "")}` : ""}`)))
        .child(right);
    });

    return v_flex().id("root").size_full().bg(t.popover).text_size(12).text_color(t.muted)
      .child(head)
      .child(v_flex().id("list").flex_1().py(4).overflow_y_scrollbar()
        .children(rows.length ? rows : [div().p(14).text_color(t.dim).child("没有正在运行的 agent")]))
      .child(div().px(12).py(6).border_t(1).border_color(t.border).text_size(10.5).text_color(t.dim)
        .child("输出 token / 分钟 · 柱图为最近 15 分钟 · Σ 会话累计输出 · 点击跳转"));
  }
}
