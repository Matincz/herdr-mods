# Usage Bar

A slim bar along the bottom of the window. On the left: Claude plan usage (5-hour and 7-day windows), then the throughput of every agent (output tokens per minute) as a small bar chart. On the right: CPU, memory, battery, and the date and time. Click the throughput to open a popup with each agent's breakdown (the `agent-throughput` mod).

![Usage Bar](preview.png)

## What you see

One 26px row (it fills its block), `text_size` 11.5, background `chrome`, a 1px `border` line along the top, 14px padding on both sides, 14px gap between groups. Left to right:

1. **Claude**: `✻ Claude` in `accent`, semibold (`✻ …` while the first load is running). Then two meters, `5h` and `7d`. Each meter is: the label (`dim`) → a 46×5px bar, radius 3, track `raised`, fill colored by level (≥85% `blocked`, ≥60% `working`, otherwise `accent`) → the percentage (`foreground`) → time to reset (`dim`, e.g. `↻4h45m`, `↻1d15h`). When the usage can't be read, it shows `不可用` ("unavailable", `dim`) instead.
2. A 1×12px separator (`border`).
3. **Throughput**: `⚡` (`working` when there is output, `dim` when idle) → a 45×12px chart of 15 bars 2px wide with a 1px gap, oldest on the left; height scaled to the busiest minute, at least 1.5px; bars with output in `accent`, empty minutes are 1px tall in `raised` → `4.4k tok/m` (`foreground` when there is output, `muted` when idle; `–` before the first result). Numbers above 1000 become `1.3k`, above 1e4 `12k`, above 1e6 `2.1M`.
4. Flexible space.
5. **Computer**: `CPU`, `MEM`, and battery (only when there is a battery; the label is `⚡` on AC, `🔋` on battery), using the same meters as Claude but without reset times. Then a separator.
6. The date and time `11/2 14:45` (`foreground`).

## How it behaves

- Click Claude: refresh right away, skipping the cache (`--force`). Tooltip: `Claude 套餐用量 · 点击立即刷新` ("Claude plan usage · click to refresh now").
- Click throughput: `openOverlay({ mod: "agent-throughput", kind: "popup", width: 400, height: 360 })`. Tooltip: `Agent 吞吐量：所有 agent 每分钟输出 token · 点击查看每个 agent` ("Agent throughput: output tokens per minute across all agents · click to see each agent").
- Refresh intervals: throughput every 5 s, CPU/memory/battery every 5 s, Claude every 60 s (the script itself caches for 5 minutes), the clock every 30 s.
- On every throughput refresh, the whole result is written to `setShared("agent.throughput", data)`, so the popup shows the same numbers without polling again.
- It doesn't react to agent status (working, blocked, done, idle). It only counts output; meter colors depend only on the percentage.

## Built from

- `main.js`: a `View` built from `h_flex` and `div`. It uses `exec`, `home`, `theme`, `setShared` and `openOverlay` from `herdr`.
- `claude-usage.mjs`: starts the local `claude` CLI (`claude -p --input-format stream-json --output-format stream-json --verbose --no-session-persistence --strict-mcp-config --settings '{"disableAllHooks":true}'`), sends `initialize` and then the `get_usage` control request, and prints `{ok, plan, five:{pct, reset}, week:{pct, reset}}`. It never reads or stores any credentials; the `claude` CLI uses its own sign-in. Cached for 5 minutes in `~/.cache/herdr-statusbar/claude-usage-raw.json`.
- `sysinfo.sh`: macOS `ps`, `sysctl`, `memory_pressure` and `pmset`; prints `{"cpu","mem","batt","ac"}`.
- Throughput comes from `../agent-throughput/throughput.mjs`, so **install both mods together**.
- Also included, but not shown in the bar (other tools can call them; each prints JSON):
  - `codex-usage.mjs`: reads the latest `rate_limits` from `~/.codex/sessions` and prints Codex's 5-hour and 7-day windows and its plan.
  - `agy-usage.mjs`: uses the sign-in Antigravity CLI saved on this machine (`~/.gemini/antigravity-cli/antigravity-oauth-token`) to call Google's `fetchAvailableModels` (each model's quota) and `loadCodeAssist` (the subscription tier, e.g. `Google AI Pro`). Cached for 5 minutes.
- `node` is found through a short `/bin/sh` snippet (`RUN_NODE`): Homebrew `/opt/homebrew/bin/node` → `/usr/local/bin/node` → `PATH` → the login shell's `command -v node` (nvm, volta).
- Put it in a layout as a block: `{"type":"block","content":{"mod":"usage-bar"},"size":{"px":26}}`. Its `mod.json` is `{"place":"none"}`.

## Watch out

- **What it accesses**: it runs `claude`, `node` and `/bin/sh`; `agy-usage.mjs` makes network requests to Google (`cloudcode-pa.googleapis.com`); `claude-usage.mjs` goes through the `claude` CLI, which talks to Anthropic. It reads files outside its own folder: `~/.codex/sessions`, `~/.gemini/antigravity-cli`, and writes caches to `~/.cache/herdr-statusbar/`.
- macOS only (`sysinfo.sh`).
- A GUI app's `PATH` contains only the system directories. Without `RUN_NODE`, `exec("node")` won't find Homebrew or nvm's node, and `claude-usage.mjs` adds the usual install locations of Claude Code (`~/.local/bin`, `~/.claude/local`, Homebrew) to `PATH` itself.
- The first line of a Codex session file (`session_meta`) is over 20KB. Read the whole line; don't cut it off at a fixed length.
- An expired Antigravity sign-in makes `agy-usage.mjs` print its last cached result (marked `stale`); agy refreshes it the next time it runs.

## Done when

- `herdr-app check mods/usage-bar` passes.
- Once it's placed in a layout, the bottom shows `✻ Claude 5h … 7d …`, and the percentages match what `/usage` shows in Claude Code.
- While an agent is producing output, `⚡` lights up, the bars move, and the number matches the total at the top of the `agent-throughput` popup.
- Clicking `⚡` opens the popup; clicking `✻ Claude` refreshes the numbers within a few seconds.
- With `PATH=/usr/bin:/bin`, `/bin/sh -c "$RUN_NODE" node claude-usage.mjs` still prints `{"ok":true,...}`.
