"use strict";
// GL Tracker: reads data/*.json (written by the scraper), writes MDL changes and extras through the GitHub API.

const STATUS = { 1: "Watching", 3: "Plan to watch", 4: "On-hold", 2: "Completed", 5: "Dropped" };
const MDL = "https://mydramalist.com/";
const ICON = {
  plus: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>',
  minus: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14"/></svg>',
  out: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg>',
  back: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 18-6-6 6-6"/></svg>',
  gear: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/></svg>',
};

const load = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode: app still works, just forgets */ } };

const cfg = load("cfg", { repo: "", token: "" });
let pending = load("pending", {}); // id -> {status?, seen?, at}: changes sent to MDL but not yet in mdl.json
const S = { shows: {}, list: {}, updated: null, listUpdated: null, extras: load("extras", { subs: ["WeTV", "iQIYI", "GagaOOLala"], shows: {} }), extrasSha: null };

// ---------- helpers ----------
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const safeUrl = (u) => (/^https?:\/\//i.test(u || "") ? u : "#");
const iso = (d) => d.toLocaleDateString("sv"); // YYYY-MM-DD in local time
const today = () => iso(new Date());
const addDays = (s, n) => { const d = new Date(s + "T12:00"); d.setDate(d.getDate() + n); return iso(d); };
const daysUntil = (s) => Math.round((new Date(s + "T12:00") - new Date(today() + "T12:00")) / 864e5);
const dayName = (s, len = "short") => new Date(s + "T12:00").toLocaleDateString("en-GB", { weekday: len });
const niceDate = (s) => new Date(s + "T12:00").toLocaleDateString("en-GB", { day: "numeric", month: "short" });
const gh = (path, opts = {}) => fetch("https://api.github.com" + path, {
  ...opts, headers: { Authorization: "Bearer " + cfg.token, "X-GitHub-Api-Version": "2022-11-28", ...(opts.headers || {}) },
});

function entry(id) {
  const e = S.list[id], p = pending[id];
  if (!e && !p) return null;
  return { status: 0, seen: 0, ...(e || {}), ...(p || {}) };
}
const tracked = (id) => [1, 3, 4].includes(entry(id)?.status);
const extra = (id) => S.extras.shows[id] || {};
const isSub = (name) => S.extras.subs.some((s) => name.toLowerCase().includes(s.toLowerCase()));
function watchLinks(s) {
  return [...(s.watch || []).map((w) => ({ ...w, from: "MDL" })), ...(extra(s.id).links || []).map((w) => ({ ...w, mine: true }))];
}
function bestPlatform(s) {
  const all = watchLinks(s);
  return all.find((w) => w.mine) || all.find((w) => isSub(w.name)) || all[0];
}
const poster = (s) => esc((s.poster || "").replace(/\?.*$/, ""));
function toast(msg) {
  const t = document.getElementById("toast");
  t.textContent = msg; t.classList.add("show");
  clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove("show"), 3200);
}

// ---------- data ----------
async function getJSON(path) {
  if (cfg.token && cfg.repo) {
    try {
      const r = await gh(`/repos/${cfg.repo}/contents/${path}`, { headers: { Accept: "application/vnd.github.raw+json" } });
      if (r.ok) return r.json();
      if (r.status === 404) return null;
    } catch { /* fall back to the hosted copy */ }
  }
  const r = await fetch(path + "?t=" + Date.now());
  return r.ok ? r.json() : null;
}

async function loadExtras() {
  if (!(cfg.token && cfg.repo)) { const d = await getJSON("data/extras.json"); if (d) S.extras = { ...S.extras, ...d }; return; }
  const r = await gh(`/repos/${cfg.repo}/contents/data/extras.json`);
  if (!r.ok) return;
  const j = await r.json();
  S.extrasSha = j.sha;
  const text = new TextDecoder().decode(Uint8Array.from(atob(j.content.replace(/\n/g, "")), (c) => c.charCodeAt(0)));
  S.extras = { ...S.extras, ...JSON.parse(text) };
  save("extras", S.extras);
}

async function loadAll() {
  const [shows, mdl] = await Promise.all([getJSON("data/shows.json"), getJSON("data/mdl.json"), loadExtras().catch(() => {})]);
  if (shows) { S.shows = shows.shows; S.updated = shows.updated; }
  if (mdl) { S.list = mdl.list; S.listUpdated = mdl.updated; }
  // Drop pending changes MDL already shows, or that are over a day old (the sync failed or was overridden).
  for (const [id, p] of Object.entries(pending)) {
    const e = S.list[id];
    const done = e && (p.status == null || e.status === p.status) && (p.seen == null || e.seen === p.seen);
    if (done || Date.now() - p.at > 864e5) delete pending[id];
  }
  save("pending", pending);
}

async function setMDL(id, change) {
  const s = S.shows[id] || {}, e = entry(id) || { seen: 0 };
  if (change.seen != null) {
    const total = s.episodes || S.list[id]?.total;
    change.seen = Math.max(0, total ? Math.min(change.seen, total) : change.seen);
    if (total && change.seen === total) change.status = 2; // MDL completes it on the last episode too
    else if (e.status !== 1 && change.seen > 0 && !change.status) change.status = 1;
  }
  pending[id] = { ...pending[id], ...change, at: Date.now() };
  save("pending", pending);
  render();
  if (!cfg.token || !cfg.repo) return toast("Saved here only. Add GitHub details in Settings to sync with MDL.");
  clearTimeout(setMDL.t?.[id]);
  setMDL.t = setMDL.t || {};
  // Debounce per show: three quick +1 taps become one sync run with the final number.
  setMDL.t[id] = setTimeout(async () => {
    const p = pending[id], inputs = { id: String(id) };
    if (p.status) inputs.status = String(p.status);
    if (p.seen != null) inputs.seen = String(p.seen);
    try {
      const r = await gh(`/repos/${cfg.repo}/actions/workflows/sync.yml/dispatches`, { method: "POST", body: JSON.stringify({ ref: "main", inputs }) });
      toast(r.ok ? "Sent to MDL, it lands in about a minute" : `GitHub said ${r.status}. Check the token in Settings.`);
    } catch { toast("Offline. The change is kept here; tap it again when you're online."); }
  }, 2500);
}

async function saveExtras(msg = "Saved") {
  save("extras", S.extras);
  render();
  if (!cfg.token || !cfg.repo) return toast("Saved on this device only. Add GitHub details in Settings to keep it everywhere.");
  const bytes = new TextEncoder().encode(JSON.stringify(S.extras, null, 1));
  let bin = ""; bytes.forEach((b) => (bin += String.fromCharCode(b)));
  const put = () => gh(`/repos/${cfg.repo}/contents/data/extras.json`, {
    method: "PUT", body: JSON.stringify({ message: "extras", content: btoa(bin), sha: S.extrasSha || undefined }),
  });
  try {
    let r = await put();
    if (r.status === 409 || r.status === 422) { // file changed elsewhere: take its sha and write ours on top
      const cur = await gh(`/repos/${cfg.repo}/contents/data/extras.json`);
      S.extrasSha = cur.ok ? (await cur.json()).sha : null;
      r = await put();
    }
    if (r.ok) { S.extrasSha = (await r.json()).content.sha; toast(msg); }
    else toast(`Couldn't save to GitHub (${r.status}). It's kept on this device.`);
  } catch { toast("Offline. Kept on this device for now."); }
}

// ---------- pieces ----------
function card(s, { line = "", chips = "", side = "", dim = false } = {}) {
  return `<a class="card${dim ? " dim" : ""}" href="#/show/${s.id}">
    <img class="poster" src="${poster(s)}" alt="" loading="lazy">
    <div class="body"><b>${esc(s.title)}</b>${line ? `<small>${line}</small>` : ""}${chips ? `<div class="chips">${chips}</div>` : ""}</div>${side}</a>`;
}
function platformChip(s) {
  const w = bestPlatform(s);
  return w ? `<span class="chip${isSub(w.name) ? " sub" : ""}">${esc(w.name)}</span>` : "";
}
const pendingChip = (id) => (pending[id] ? `<span class="chip pending">${cfg.token ? "syncing to MDL" : "not synced"}</span>` : "");
function empty(title, text) { return `<div class="empty"><b>${title}</b>${text}</div>`; }
const glShows = () => Object.values(S.shows).filter((s) => s.gl && !extra(s.id).hidden);

// ---------- views ----------
function weekView() {
  const t = today(), all = load("weekAll", false), weekAgo = addDays(t, -7);
  const fresh = [];
  for (const s of Object.values(S.shows)) {
    const e = entry(s.id);
    if (e?.status !== 1) continue;
    const out = (s.eps || []).filter((x) => x.date && x.date <= t && x.n > e.seen);
    const recent = out.filter((x) => x.date > weekAgo); // only what dropped this past week, not a whole backlog
    if (recent.length) fresh.push({ s, out, recent });
  }
  let html = `<div class="top"><h1>This <em>week</em></h1><a class="btn round" href="#/settings" aria-label="Settings">${ICON.gear}</a></div>`;
  html += `<div class="seg" role="group" aria-label="Which shows">
    <button data-weekall="0" aria-pressed="${!all}">My list</button><button data-weekall="1" aria-pressed="${all}">All GL</button></div>`;
  if (fresh.length) {
    html += `<h2><span class="tag today">Ready to watch</span></h2>`;
    html += fresh.map(({ s, out, recent }) => card(s, {
      line: `Episode ${recent.at(-1).n} came out ${recent.at(-1).date === t ? "today" : dayName(recent.at(-1).date, "long")}${out.length > 1 ? ` · ${out.length} unwatched` : ""}`,
      chips: platformChip(s) + pendingChip(s.id),
      side: `<button class="btn round primary" data-plus="${s.id}" aria-label="Mark episode ${out[0].n} of ${esc(s.title)} as watched">${ICON.plus}</button>`,
    })).join("");
  }
  let any = false;
  for (let i = 0; i < 7; i++) {
    const d = addDays(t, i);
    const items = [];
    for (const s of Object.values(S.shows)) {
      if (!(tracked(s.id) || (all && s.gl && !extra(s.id).hidden))) continue;
      for (const x of s.eps || []) if (x.date === d) items.push({ s, x });
    }
    if (!items.length) continue;
    any = true;
    html += `<h2><span class="tag${i === 0 ? " today" : ""}">${i === 0 ? "Today" : i === 1 ? "Tomorrow" : dayName(d, "long")}</span><span class="sub">${niceDate(d)}</span></h2>`;
    html += items.map(({ s, x }) => card(s, {
      line: `Episode ${x.n}${s.episodes ? ` of ${s.episodes}` : ""}${s.network ? " · " + esc(s.network) : ""}`,
      chips: platformChip(s) + (x.est ? `<span class="chip est">date estimated</span>` : "") + (tracked(s.id) ? "" : `<span class="chip">not on your list</span>`),
      dim: !tracked(s.id),
    })).join("");
  }
  if (!any && !fresh.length) html += empty("Nothing airing for you this week", all ? "No GL episodes found in the next 7 days." : "Switch to All GL, or add shows from Soon and Browse.");
  html += `<p class="hint">Dates are the airing date in the show's country. Updated ${S.updated ? new Date(S.updated).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" }) : "never"}.</p>`;
  return html;
}

function soonView() {
  const t = today();
  const up = glShows().filter((s) => (s.start ? s.start > t : !(s.eps || []).some((x) => x.date && x.date <= t)));
  up.sort((a, b) => (a.start || "9999").localeCompare(b.start || "9999") || a.title.localeCompare(b.title));
  let html = `<h1>Coming <em>soon</em></h1><p class="sub">${up.length} upcoming GL shows on MDL</p>`;
  if (!up.length) return html + empty("No upcoming shows found", "The next update runs within 3 hours.");
  return html + up.map((s) => {
    const e = entry(s.id);
    const when = s.start ? `${niceDate(s.start)} · in ${daysUntil(s.start)} day${daysUntil(s.start) === 1 ? "" : "s"}` : "Date not announced";
    const side = e?.status ? `<span class="chip">${STATUS[e.status]}</span>` : `<button class="btn" data-plan="${s.id}">Plan</button>`;
    return card(s, { line: `${esc(s.country || "")}${s.episodes ? ` · ${s.episodes} episodes` : ""}`, chips: `<span class="chip${s.start && daysUntil(s.start) <= 7 ? " new" : ""}">${when}</span>` + pendingChip(s.id), side });
  }).join("");
}

function listView() {
  const tab = Number(load("listTab", 1));
  const ids = Object.keys({ ...S.list, ...pending });
  const count = (st) => ids.filter((id) => entry(id)?.status === st).length;
  let html = `<h1>My <em>list</em></h1><p class="sub">From your MyDramaList. Changes here sync back to it.</p>`;
  html += `<div class="seg" role="group" aria-label="Status">${Object.entries(STATUS).map(([k, v]) =>
    `<button data-listtab="${k}" aria-pressed="${tab === Number(k)}">${v}<span>${count(Number(k))}</span></button>`).join("")}</div>`;
  const rows = ids.filter((id) => entry(id)?.status === tab).map((id) => {
    const e = entry(id), s = { ...S.list[id], ...S.shows[id], id };
    const total = s.episodes || e.total;
    const next = (s.eps || []).find((x) => x.n === e.seen + 1);
    return { s, e, total, next, sort: next?.date || "9999" };
  });
  rows.sort((a, b) => a.sort.localeCompare(b.sort) || (a.s.title || "").localeCompare(b.s.title || ""));
  if (!rows.length) return html + empty(`Nothing in ${STATUS[tab]}`, "Add shows from Soon or Browse.");
  return html + rows.map(({ s, e, total, next }) => {
    const nextTxt = next?.date ? (next.date <= today() ? `Ep ${next.n} is out` : `Ep ${next.n} on ${dayName(next.date)} ${niceDate(next.date)}`) : "";
    const side = tab === 1 ? `<div class="stepper"><output aria-label="Episodes watched">${e.seen}/${total ?? "?"}</output>
      <button class="btn round primary" data-plus="${s.id}" aria-label="Watched one more episode of ${esc(s.title)}">${ICON.plus}</button></div>` : "";
    return card(s, { line: [tab === 1 ? "" : `${e.seen}/${total ?? "?"} seen`, nextTxt].filter(Boolean).join(" · "), chips: (tab === 1 ? platformChip(s) : "") + pendingChip(s.id), side });
  }).join("");
}

function browseView() {
  const q = load("q", ""), country = load("country", "");
  const all = glShows();
  const countries = [...new Set(all.map((s) => s.country).filter(Boolean))].sort();
  const t = today();
  const list = all.filter((s) => (!country || s.country === country) && (!q || (s.title + " " + (s.native || "")).toLowerCase().includes(q.toLowerCase())))
    .sort((a, b) => (b.start || "").localeCompare(a.start || ""));
  let html = `<h1>All <em>GL</em> shows</h1><p class="sub">Newest from MDL's Lesbian Romance tag</p>
    <input type="search" id="q" value="${esc(q)}" placeholder="Search title" aria-label="Search title">
    <div class="seg" role="group" aria-label="Country"><button data-country="" aria-pressed="${!country}">All</button>${countries.map((c) =>
      `<button data-country="${esc(c)}" aria-pressed="${c === country}">${esc(c)}</button>`).join("")}</div>`;
  if (!list.length) return html + empty("No matches", "Try another title or country.");
  return html + list.map((s) => {
    const e = entry(s.id);
    const state = s.start && s.start > t ? "Upcoming" : s.end && s.end < t ? "Finished" : s.start ? "Airing" : "Upcoming";
    return card(s, {
      line: `${esc(s.country || "")} · ${state}${s.episodes ? ` · ${s.episodes} eps` : ""}`,
      chips: (e?.status ? `<span class="chip">${STATUS[e.status]}</span>` : "") + platformChip(s) + pendingChip(s.id),
    });
  }).join("") + (all.length < Object.values(S.shows).filter((s) => s.gl).length ? `<p class="hint"><a href="#/settings">Hidden shows</a> are left out.</p>` : "");
}

function showView(id) {
  const s = { ...S.list[id], ...S.shows[id], id };
  if (!s.title) return `<a class="back" href="#/week">${ICON.back}Back</a>` + empty("Show not found", "It may have dropped out of the data.");
  const e = entry(id) || { status: 0, seen: 0 }, x = extra(id);
  const total = s.episodes || e.total;
  let html = `<a class="back" href="javascript:history.back()">${ICON.back}Back</a>
    <div class="hero"><img src="${poster(s).replace("_4s.", "_4c.").replace("_4t.", "_4c.")}" alt="">
    <div><h1>${esc(s.title)}</h1>${s.native && s.native !== s.title ? `<p class="sub">${esc(s.native)}</p>` : ""}
    <p class="sub">${[s.country, s.network, s.airDays?.join(", "), s.airText].filter(Boolean).map(esc).join(" · ")}</p>
    ${s.score && s.score !== "N/A" ? `<span class="chip">MDL ${esc(s.score)}</span>` : ""} ${pendingChip(id)}</div></div>`;

  html += `<section class="panel" aria-labelledby="h-prog"><h2 id="h-prog">Progress</h2>
    <div class="row"><select id="status" aria-label="List status"><option value="0"${e.status ? "" : " selected"} disabled>Not on my list</option>${Object.entries(STATUS).map(([k, v]) =>
      `<option value="${k}"${e.status === Number(k) ? " selected" : ""}>${v}</option>`).join("")}</select></div>
    <div class="row" style="margin-top:10px"><div class="stepper">
      <button class="btn round" data-minus="${id}" aria-label="One episode less"${e.seen ? "" : " disabled"}>${ICON.minus}</button>
      <output aria-label="Episodes watched">${e.seen}/${total ?? "?"}</output>
      <button class="btn round primary" data-plus="${id}" aria-label="Watched one more episode"${total && e.seen >= total ? " disabled" : ""}>${ICON.plus}</button></div>
      <span class="sub">episodes watched</span></div></section>`;

  const links = watchLinks(s);
  html += `<section class="panel" aria-labelledby="h-where"><h2 id="h-where">Where to watch</h2>`;
  html += links.length ? `<ul class="where">${links.map((w, i) => `<li><a href="${esc(safeUrl(w.url))}" target="_blank" rel="noopener">${esc(w.name)}${ICON.out}</a>
      ${isSub(w.name) ? `<span class="chip sub">subscribed</span>` : ""}<small>${esc(w.mine ? "my link" : w.kind || "")}</small>
      ${w.mine ? `<button class="linkbtn" data-dellink="${i - (s.watch || []).length}">remove</button>` : ""}</li>`).join("")}</ul>`
    : `<p class="sub">MDL lists nowhere yet. Add where you found it.</p>`;
  html += `<form id="addlink" class="row" style="margin-top:10px">
      <input type="text" name="name" placeholder="Name, e.g. YouTube" aria-label="Link name" required style="flex:1 1 120px">
      <input type="url" name="url" placeholder="https://" aria-label="Link address" required style="flex:2 1 180px">
      <button class="btn">Add link</button></form></section>`;

  if (s.eps?.length) {
    const nextN = e.seen + 1;
    html += `<section class="panel" aria-labelledby="h-eps"><h2 id="h-eps">Episodes</h2><ul class="eps">${s.eps.map((ep) =>
      `<li class="${ep.n <= e.seen ? "seen" : ep.n === nextN ? "next" : ""}"><span>Episode ${ep.n}</span><span>${ep.date ? `${dayName(ep.date)} ${niceDate(ep.date)}${ep.est ? " (est.)" : ""}` : "date unknown"}</span></li>`).join("")}</ul></section>`;
  }

  html += `<section class="panel" aria-labelledby="h-note"><h2 id="h-note">My note</h2>
    <textarea id="note" placeholder="Anything to remember, e.g. subs come a day later on WeTV">${esc(x.note || "")}</textarea>
    <div class="row" style="margin-top:10px"><button class="btn" id="savenote">Save note</button>
    ${s.gl ? `<button class="btn" id="hide">${x.hidden ? "Show in lists again" : "Hide from Soon and Browse"}</button>` : ""}
    <a class="btn" href="${MDL}${esc(s.slug || id)}" target="_blank" rel="noopener">Open on MDL ${ICON.out}</a></div></section>`;
  if (s.synopsis) html += `<p class="synopsis">${esc(s.synopsis)}</p>`;
  return html;
}

function settingsView() {
  const hidden = Object.entries(S.extras.shows).filter(([, v]) => v.hidden);
  return `<a class="back" href="#/week">${ICON.back}Back</a><h1>Settings</h1>
  <form id="cfg">
    <label for="repo">GitHub repository</label>
    <input type="text" id="repo" name="repo" value="${esc(cfg.repo)}" placeholder="your-name/gl-tracker" autocomplete="off" autocapitalize="off">
    <label for="token">GitHub token</label>
    <input type="password" id="token" name="token" value="${esc(cfg.token)}" placeholder="github_pat_..." autocomplete="off">
    <p class="hint">A fine-grained token for this one repository with "Contents" and "Actions" set to read and write. It stays on this device.</p>
    <label for="subs">My subscriptions</label>
    <input type="text" id="subs" name="subs" value="${esc(S.extras.subs.join(", "))}">
    <p class="hint">Comma separated. These get a green tag.</p>
    <div class="row" style="margin-top:14px"><button class="btn primary">Save settings</button></div>
  </form>
  ${hidden.length ? `<h2>Hidden shows</h2>${hidden.map(([id]) => `<div class="row"><span style="flex:1">${esc(S.shows[id]?.title || id)}</span><button class="linkbtn" data-unhide="${id}">unhide</button></div>`).join("")}` : ""}
  <p class="hint">Shows updated ${S.updated ? new Date(S.updated).toLocaleString("en-GB") : "never"}. MDL list read ${S.listUpdated ? new Date(S.listUpdated).toLocaleString("en-GB") : "never"}.</p>`;
}

// ---------- router ----------
function render() {
  const [, view = "week", id] = location.hash.split("/");
  const main = document.getElementById("view");
  const html = { week: weekView, soon: soonView, list: listView, browse: browseView, settings: settingsView }[view]?.() ?? (view === "show" ? showView(id) : weekView());
  const changed = main.dataset.view !== location.hash;
  main.innerHTML = html;
  if (changed) {
    main.dataset.view = location.hash;
    main.classList.remove("turn"); void main.offsetWidth; main.classList.add("turn");
    window.scrollTo(0, 0);
  }
  document.querySelectorAll(".tabs a").forEach((a) => (a.dataset.tab === view ? a.setAttribute("aria-current", "page") : a.removeAttribute("aria-current")));
}

document.addEventListener("click", (ev) => {
  const b = ev.target.closest("button");
  if (!b) return;
  const d = b.dataset, id = location.hash.split("/")[2];
  if (d.plus || d.minus) {
    ev.preventDefault();
    const sid = d.plus || d.minus, e = entry(sid) || { seen: 0 };
    return setMDL(sid, { seen: e.seen + (d.plus ? 1 : -1) });
  }
  if (d.plan) { ev.preventDefault(); return setMDL(d.plan, { status: 3 }); }
  if (d.weekall) { save("weekAll", d.weekall === "1"); return render(); }
  if (d.listtab) { save("listTab", Number(d.listtab)); return render(); }
  if (d.country !== undefined) { save("country", d.country); return render(); }
  if (d.unhide) { S.extras.shows[d.unhide] = { ...extra(d.unhide), hidden: false }; return saveExtras("Unhidden"); }
  if (d.dellink !== undefined) {
    const links = [...(extra(id).links || [])]; links.splice(Number(d.dellink), 1);
    S.extras.shows[id] = { ...extra(id), links }; return saveExtras("Link removed");
  }
  if (b.id === "savenote") { S.extras.shows[id] = { ...extra(id), note: document.getElementById("note").value.trim() }; return saveExtras("Note saved"); }
  if (b.id === "hide") { S.extras.shows[id] = { ...extra(id), hidden: !extra(id).hidden }; return saveExtras(extra(id).hidden ? "Hidden" : "Visible again"); }
});

document.addEventListener("change", (ev) => {
  if (ev.target.id === "status") setMDL(location.hash.split("/")[2], { status: Number(ev.target.value) });
});

document.addEventListener("input", (ev) => {
  if (ev.target.id !== "q") return;
  save("q", ev.target.value);
  clearTimeout(render.q);
  render.q = setTimeout(() => { const pos = ev.target.selectionStart; render(); const q = document.getElementById("q"); q.focus(); q.setSelectionRange(pos, pos); }, 200);
});

document.addEventListener("submit", (ev) => {
  ev.preventDefault();
  const f = ev.target, id = location.hash.split("/")[2];
  if (f.id === "addlink") {
    const url = f.url.value.trim();
    if (!/^https?:\/\//i.test(url)) return toast("The link has to start with https://");
    S.extras.shows[id] = { ...extra(id), links: [...(extra(id).links || []), { name: f.name.value.trim(), url }] };
    return saveExtras("Link added");
  }
  if (f.id === "cfg") {
    cfg.repo = f.repo.value.trim().replace(/^https:\/\/github\.com\//, "").replace(/\/$/, "");
    cfg.token = f.token.value.trim();
    save("cfg", cfg);
    S.extras.subs = f.subs.value.split(",").map((s) => s.trim()).filter(Boolean);
    loadAll().then(() => saveExtras("Settings saved"));
  }
});

window.addEventListener("hashchange", render);
document.addEventListener("visibilitychange", () => { if (!document.hidden) loadAll().then(render); });

(async () => {
  render();
  try { await loadAll(); } catch { toast("Couldn't load the show data. Showing what's saved."); }
  render();
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
})();
