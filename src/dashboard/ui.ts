export function renderDashboardHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Ambrogio Dashboard</title>
  <style>
    :root {
      --bg: #f8f5ee;
      --ink: #1f2937;
      --panel: #fffdf9;
      --line: #ded6c8;
      --accent: #0f766e;
      --muted: #6b7280;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: "Avenir Next", "Helvetica Neue", "Segoe UI", sans-serif;
      background: radial-gradient(circle at 10% 5%, #fffbeb 0%, var(--bg) 46%, #eef6f6 100%);
      color: var(--ink);
    }
    .wrap { max-width: 980px; margin: 0 auto; padding: 14px; }
    .title { margin: 0; font-size: 1.3rem; letter-spacing: 0.02em; }
    .meta { margin: 6px 0 10px; color: var(--muted); font-size: 0.85rem; }
    .note {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 10px;
      padding: 10px;
      font-size: 0.86rem;
    }
    .tabs { display: flex; gap: 8px; margin: 12px 0; }
    .tab {
      border: 1px solid var(--line);
      background: var(--panel);
      border-radius: 999px;
      padding: 7px 11px;
      font-size: 0.86rem;
      cursor: pointer;
    }
    .tab.active { border-color: var(--accent); color: var(--accent); }
    .view { display: none; }
    .view.active { display: block; }
    .card {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 12px;
      padding: 10px;
      margin-bottom: 8px;
    }
    .health-grid { display: grid; grid-template-columns: 1fr; gap: 10px; }
    .health-card { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 10px; }
    .health-top { display: flex; justify-content: space-between; gap: 8px; align-items: center; margin-bottom: 4px; }
    .pill {
      border-radius: 999px;
      padding: 2px 8px;
      font-size: 0.75rem;
      border: 1px solid var(--line);
      background: #f3f4f6;
      color: #111827;
    }
    .pill.ok { background: #ecfdf5; color: #065f46; border-color: #6ee7b7; }
    .pill.warn { background: #fff7ed; color: #9a3412; border-color: #fdba74; }
    .pill.critical { background: #fef2f2; color: #991b1b; border-color: #fca5a5; }
    .muted { color: var(--muted); font-size: 0.84rem; }
    .board { display: grid; grid-template-columns: 1fr; gap: 10px; }
    .preview {
      margin-top: 8px;
      font-family: ui-monospace, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
      white-space: pre-wrap;
      font-size: 0.8rem;
      line-height: 1.35;
      max-height: 260px;
      overflow: auto;
      background: #f9fafb;
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 8px;
    }
    .col { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 10px; }
    .col h3 { margin: 0 0 8px; font-size: 0.9rem; }
    ul { margin: 0; padding-left: 16px; }
    li { margin: 4px 0; }
    @media (min-width: 800px) {
      .board { grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); }
    }
  </style>
</head>
<body>
  <main class="wrap">
    <h1 class="title">Ambrogio Dashboard</h1>
    <p class="meta" id="meta">Loading...</p>
    <div class="note">Read-only dashboard. To edit jobs, todos, and groceries use Telegram agent commands.</div>
    <div class="tabs">
      <button class="tab active" data-view="calendar">Calendar</button>
      <button class="tab" data-view="health">Health</button>
      <button class="tab" data-view="todos">Todos</button>
      <button class="tab" data-view="groceries">Groceries</button>
      <button class="tab" data-view="knowledge">Knowledge</button>
      <button class="tab" data-view="skillstate">Skill State</button>
    </div>
    <section id="calendar" class="view active"></section>
    <section id="health" class="view"></section>
    <section id="todos" class="view"></section>
    <section id="groceries" class="view"></section>
    <section id="knowledge" class="view"></section>
    <section id="skillstate" class="view"></section>
  </main>
  <script>
    const views = ["calendar", "health", "todos", "groceries", "knowledge", "skillstate"];
    for (const tab of document.querySelectorAll(".tab")) {
      tab.addEventListener("click", () => {
        for (const id of views) document.getElementById(id).classList.remove("active");
        for (const t of document.querySelectorAll(".tab")) t.classList.remove("active");
        document.getElementById(tab.dataset.view).classList.add("active");
        tab.classList.add("active");
      });
    }

    function asText(v) {
      return String(v).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
    }

    function renderDynamicColumns(targetId, columns) {
      const target = document.getElementById(targetId);
      if (!columns.length) {
        target.innerHTML = "<p class='muted'>No columns found.</p>";
        return;
      }
      target.innerHTML = \`
        <div class="board">
          \${columns.map((column) => \`
            <article class="col">
              <h3>\${asText(column.title)} (\${column.items.length})</h3>
              <ul>\${(column.items || []).map((item) => \`<li>\${asText(item.text)}</li>\`).join("") || "<li class='muted'>No items</li>"}</ul>
            </article>
          \`).join("")}
        </div>
      \`;
    }

    function renderCalendar(jobs) {
      const el = document.getElementById("calendar");
      if (!jobs.length) {
        el.innerHTML = "<p class='muted'>No upcoming scheduled jobs.</p>";
        return;
      }
      el.innerHTML = jobs.map((job) => \`
        <article class="card">
          <strong>\${new Date(job.runAt).toLocaleString()}</strong>
          <div>\${asText(job.requestPreview)}</div>
          <div class="muted">\${asText(job.kind)} | \${asText(job.status)}\${job.recurrenceExpression ? " | " + asText(job.recurrenceExpression) : ""}</div>
        </article>
      \`).join("");
    }

    function renderHealth(health) {
      const el = document.getElementById("health");
      if (!health) {
        el.innerHTML = "<p class='muted'>Health data unavailable.</p>";
        return;
      }
      const heartbeat = health.heartbeat || {};
      const errors = health.errors || {};
      const pending = health.pending || {};
      const uptime = health.uptime || {};
      const hbStatus = asText(heartbeat.status || "warn");
      const hbLastRun = heartbeat.lastRunAt ? new Date(heartbeat.lastRunAt).toLocaleString() : "n/a";
      const hbMinutes = heartbeat.minutesSinceLastRun ?? "n/a";
      el.innerHTML = \`
        <div class="health-grid">
          <article class="health-card">
            <div class="health-top">
              <strong>Heartbeat</strong>
              <span class="pill \${hbStatus}">\${hbStatus.toUpperCase()}</span>
            </div>
            <div class="muted">Last run: \${asText(hbLastRun)} | Last result: \${asText(heartbeat.lastResult || "n/a")}</div>
            <div class="muted">Minutes since last run: \${asText(String(hbMinutes))}</div>
          </article>
          <article class="health-card">
            <div class="health-top"><strong>Errors</strong><span class="pill \${errors.total > 0 ? "critical" : "ok"}">\${errors.total > 0 ? "ACTIVE" : "CLEAR"}</span></div>
            <div class="muted">Failed pending delivery: \${asText(String(errors.failedPendingDelivery || 0))}</div>
            <div class="muted">Heartbeat error flag: \${asText(errors.heartbeatError ? "yes" : "no")}</div>
          </article>
          <article class="health-card">
            <div class="health-top"><strong>Pending</strong><span class="pill \${pending.total > 0 ? "warn" : "ok"}">\${pending.total > 0 ? "ATTENTION" : "OK"}</span></div>
            <div class="muted">Scheduled: \${asText(String(pending.scheduled || 0))}</div>
            <div class="muted">Running: \${asText(String(pending.running || 0))}</div>
            <div class="muted">Pending delivery: \${asText(String(pending.pendingDelivery || 0))}</div>
          </article>
          <article class="health-card">
            <div class="health-top"><strong>Uptime</strong><span class="pill ok">LIVE</span></div>
            <div class="muted">Human: \${asText(String(uptime.human || "n/a"))}</div>
            <div class="muted">Seconds: \${asText(String(uptime.seconds || 0))}</div>
          </article>
        </div>
      \`;
    }

    function renderKnowledge(knowledge) {
      const el = document.getElementById("knowledge");
      if (!knowledge) {
        el.innerHTML = "<p class='muted'>Knowledge data unavailable.</p>";
        return;
      }
      const memory = knowledge.memory || {};
      const notes = knowledge.notes || {};
      const counts = knowledge.stateCounts || {};
      const memoryUpdated = memory.updatedAt ? new Date(memory.updatedAt).toLocaleString() : "n/a";
      const notesUpdated = notes.updatedAt ? new Date(notes.updatedAt).toLocaleString() : "n/a";
      const memoryPreview = (memory.previewLines || []).join("\\n");
      const notesPreview = (notes.previewLines || []).join("\\n");
      el.innerHTML = \`
        <div class="health-grid">
          <article class="health-card">
            <div class="health-top"><strong>MEMORY.md</strong><span class="pill \${memory.exists ? "ok" : "warn"}">\${memory.exists ? "PRESENT" : "MISSING"}</span></div>
            <div class="muted">Updated: \${asText(memoryUpdated)}</div>
            <div class="muted">State entries (memory:*): \${asText(String(counts.memoryEntries || 0))}</div>
            <div class="preview">\${asText(memoryPreview || "No content found.")}</div>
          </article>
          <article class="health-card">
            <div class="health-top"><strong>NOTES.md</strong><span class="pill \${notes.exists ? "ok" : "warn"}">\${notes.exists ? "PRESENT" : "MISSING"}</span></div>
            <div class="muted">Updated: \${asText(notesUpdated)}</div>
            <div class="muted">State entries (notes:entry:*): \${asText(String(counts.notesEntries || 0))}</div>
            <div class="preview">\${asText(notesPreview || "No content found.")}</div>
          </article>
        </div>
      \`;
    }

    function renderSkillState(skillState) {
      const el = document.getElementById("skillstate");
      if (!skillState) {
        el.innerHTML = "<p class='muted'>Skill state unavailable.</p>";
        return;
      }
      el.innerHTML = \`
        <div class="health-grid">
          <article class="health-card">
            <div class="health-top"><strong>fetch-url cache</strong><span class="pill">\${asText(String(skillState.fetchUrlCacheEntries || 0))}</span></div>
            <div class="muted">Pattern: fetch-url:cache:*</div>
          </article>
          <article class="health-card">
            <div class="health-top"><strong>TTS cache</strong><span class="pill">\${asText(String(skillState.ttsAudioCacheEntries || 0))}</span></div>
            <div class="muted">Pattern: tts:audio:*</div>
          </article>
          <article class="health-card">
            <div class="health-top"><strong>ATM tram cache</strong><span class="pill">\${asText(String(skillState.atmTramScheduleCacheEntries || 0))}</span></div>
            <div class="muted">Pattern: atm-tram-schedule:cache:*</div>
          </article>
          <article class="health-card">
            <div class="health-top"><strong>ATM GTFS timestamp</strong><span class="pill \${skillState.atmTramScheduleGtfsTimestampPresent ? "ok" : "warn"}">\${skillState.atmTramScheduleGtfsTimestampPresent ? "PRESENT" : "MISSING"}</span></div>
            <div class="muted">Key: atm-tram-schedule:gtfs:timestamp</div>
          </article>
        </div>
      \`;
    }

    async function refresh() {
      const response = await fetch("/dashboard/api/snapshot", { cache: "no-store" });
      const data = await response.json();
      document.getElementById("meta").textContent = "Updated " + new Date(data.generatedAt).toLocaleString() + " (" + data.timezone + ")";
      renderCalendar(data.jobs || []);
      renderHealth(data.health || null);
      renderDynamicColumns("todos", data.todo?.columns || []);
      renderDynamicColumns("groceries", data.groceries?.columns || []);
      renderKnowledge(data.knowledge || null);
      renderSkillState(data.skillState || null);
    }

    refresh().catch((error) => {
      document.getElementById("meta").textContent = "Failed to load dashboard data.";
      console.error(error);
    });
    setInterval(() => { refresh().catch(() => {}); }, 30000);
  </script>
</body>
</html>`;
}
