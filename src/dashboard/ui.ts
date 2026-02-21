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
    .muted { color: var(--muted); font-size: 0.84rem; }
    .board { display: grid; grid-template-columns: 1fr; gap: 10px; }
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
      <button class="tab" data-view="todos">Todos</button>
      <button class="tab" data-view="groceries">Groceries</button>
    </div>
    <section id="calendar" class="view active"></section>
    <section id="todos" class="view"></section>
    <section id="groceries" class="view"></section>
  </main>
  <script>
    const views = ["calendar", "todos", "groceries"];
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

    async function refresh() {
      const response = await fetch("/dashboard/api/snapshot", { cache: "no-store" });
      const data = await response.json();
      document.getElementById("meta").textContent = "Updated " + new Date(data.generatedAt).toLocaleString() + " (" + data.timezone + ")";
      renderCalendar(data.jobs || []);
      renderDynamicColumns("todos", data.todo?.columns || []);
      renderDynamicColumns("groceries", data.groceries?.columns || []);
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
