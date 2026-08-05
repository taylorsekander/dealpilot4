/* ============================================================================
   APP — state machine and screen rendering.

   Screens: landing → intake → searching → results
   One state object, one render(). Events are delegated from document.
   ============================================================================ */

import { CONFIG } from "./config.js";
import {
  EMPTY_CRITERIA, money, applyFilters, SORTS, parseFreeText, zipFrom,
} from "./domain.js";
import {
  MOCK_INVENTORY, CATALOG, ALL_MAKES, ALL_MODELS, modelsForMake, EXTERIOR_COLORS,
} from "./mock-inventory.js";
import { inventoryService, authService, aiService, leadService, analytics } from "./services.js";
import { vehicleCard, vehicleArt, chip, eyebrow, esc } from "./ui.js";

/* -------------------------------------------------------------------- state ----------- */
const state = {
  screen: "landing",
  criteria: { ...EMPTY_CRITERIA },
  stepIndex: 0,
  messages: [],
  results: [],
  relaxed: [],
  source: null,
  searchError: null,
  summary: null,
  summaryLoading: false,
  liveError: null,
  filters: null,
  sort: "match",
  filtersOpen: false,
  saved: [],
  user: null,
  modal: null, // { type: 'auth' | 'lead' | 'detail', vehicle? }
};

const $ = (sel) => document.querySelector(sel);
const byId = (id) => state.results.find((v) => v.id === id);

/* --------------------------------------------------------------- intake script -------- */
/* Adding a question = adding an entry here. Nothing else changes. */
const STEPS = [
  { key: "condition", field: "condition",
    prompt: () => "Let's find your car. First: are you shopping new, used, or open to either?",
    options: () => [
      { label: "New", value: "New" }, { label: "Used", value: "Used" },
      { label: "Certified pre-owned", value: "Certified" }, { label: "Open to either", value: "Any" },
    ] },
  { key: "make", field: "make",
    prompt: () => "Which brand are you leaning toward?",
    options: () => [...ALL_MAKES.map((m) => ({ label: m, value: m })), { label: "I'm open", value: "Any" }],
    freeTextHint: "or type any brand" },
  { key: "model", field: "model",
    prompt: (c) => (c.make === "Any" ? "Any particular model on your list?" : `Which ${c.make}?`),
    options: (c) => (c.make === "Any"
      ? [{ label: "No specific model", value: "Any" }]
      : [...modelsForMake(c.make).map((m) => ({ label: m.name, value: m.name })), { label: "Show me all of them", value: "Any" }]),
    freeTextHint: "or type the model" },
  { key: "trim", field: "trim",
    prompt: (c) => (c.model === "Any" ? "Any trim level in mind?" : `Which ${c.model} trim? This is a hard requirement — I won't show you a different trim without saying so.`),
    options: (c) => {
      const m = modelsForMake(c.make).find((x) => x.name === c.model);
      return [...(m ? m.trims.map((t) => ({ label: t, value: t })) : []), { label: "No preference", value: "Any" }];
    },
    freeTextHint: "or type the trim" },
  { key: "budget", field: "budget",
    prompt: () => "What's your ceiling? Vehicle price, before tax and fees.",
    options: () => [
      { label: "Under $25,000", value: { budgetMin: null, budgetMax: 25000 } },
      { label: "$25k – $35k", value: { budgetMin: 25000, budgetMax: 35000 } },
      { label: "$35k – $45k", value: { budgetMin: 35000, budgetMax: 45000 } },
      { label: "$45k – $70k", value: { budgetMin: 45000, budgetMax: 70000 } },
    ],
    freeTextHint: 'or type a number — "about 38k"' },
  { key: "mileage", field: "maxMileage",
    skipIf: (c) => c.condition === "New",
    prompt: () => "How many miles are you willing to live with?",
    options: () => [
      { label: "Under 15,000", value: 15000 }, { label: "Under 30,000", value: 30000 },
      { label: "Under 60,000", value: 60000 }, { label: "Not a dealbreaker", value: 200000 },
    ] },
  { key: "color", field: "color",
    prompt: () => "Any exterior color you actually want?",
    options: () => {
      const groups = [...new Set(EXTERIOR_COLORS.map((c) => c.group))];
      return [...groups.map((g) => ({ label: g, value: g, swatch: EXTERIOR_COLORS.find((c) => c.group === g).hex })),
        { label: "No preference", value: "Any" }];
    } },
  { key: "location", field: "location",
    prompt: () => "Where are you shopping from? A ZIP works best.",
    options: () => [{ label: "20147", value: "20147" }, { label: "20016", value: "20016" }, { label: "22030", value: "22030" }],
    freeTextHint: "type your ZIP or city" },
  { key: "radius", field: "radiusMi",
    prompt: () => "How far are you willing to drive to pick it up?",
    options: () => [
      { label: "Within 15 mi", value: 15 }, { label: "Within 30 mi", value: 30 },
      { label: "Within 50 mi", value: 50 }, { label: "Up to 100 mi", value: 100 },
    ] },
];

const activeSteps = () => STEPS.filter((s) => !s.skipIf || !s.skipIf(state.criteria));
const currentStep = () => activeSteps()[state.stepIndex] || null;
const resolve = (p, c) => (typeof p === "function" ? p(c) : p);

const SHEET_ROWS = [
  ["condition", "Condition"], ["make", "Make"], ["model", "Model"], ["trim", "Trim"],
  ["budget", "Budget"], ["mileage", "Max miles"], ["color", "Color"],
  ["location", "Location"], ["radius", "Radius"],
];

function sheetValue(key) {
  const c = state.criteria;
  switch (key) {
    case "budget": return c.budgetMax ? (c.budgetMin ? `${money(c.budgetMin)}–${money(c.budgetMax)}` : `≤ ${money(c.budgetMax)}`) : null;
    case "mileage": return c.condition === "New" ? "n/a" : c.maxMileage ? `≤ ${c.maxMileage.toLocaleString()}` : null;
    case "radius": return c.radiusMi ? `${c.radiusMi} mi` : null;
    case "location": return c.location;
    default: return c[key];
  }
}

/* ------------------------------------------------------------------- screens ---------- */
function landingHTML() {
  return `
  <section class="dp-hero">
    <div class="dp-hero-grid">
      <div class="dp-hero-copy">
        ${eyebrow("Buyer's agent · not a dealer's listing site")}
        <h1 class="dp-display dp-h1">Never walk into<br>a dealership<br><span class="dp-h1-accent">underinformed</span></h1>
        <p class="dp-lede">Tell DealPilot what you're after in plain language. It scans dealer inventory in your
          radius, puts every listing on the same spec sheet, and tells you which one is actually priced to move.</p>
        <div class="dp-hero-actions">
          <button class="dp-btn dp-btn-primary" data-action="start">Start your search →</button>
          <span class="dp-mono dp-muted dp-hero-note">No account needed to search</span>
        </div>
        <dl class="dp-hero-stats dp-mono">
          <div><dt>Fields compared</dt><dd>13 per listing</dd></div>
          <div><dt>Exact-match policy</dt><dd>Trim is a hard filter</dd></div>
          <div><dt>Who we work for</dt><dd>You</dd></div>
        </dl>
      </div>

      <div class="dp-hero-demo">
        <div class="dp-demo-head dp-mono"><span class="dp-dot"></span> DEALPILOT AGENT</div>
        <div class="dp-demo-body">
          <div class="dp-bubble dp-bubble-agent dp-anim">Hi — I'm your buyer's agent. Nine quick questions, then I go read the lot for you.</div>
          <div class="dp-bubble dp-bubble-agent dp-anim dp-delay-1">First: are you shopping new, used, or open to either?</div>
          <div class="dp-demo-chips dp-anim dp-delay-2">
            ${["New", "Used", "Certified", "Any"].map((v, i) =>
              chip(["New", "Used", "Certified pre-owned", "Open to either"][i], { value: v, action: "start-with" })).join("")}
          </div>
        </div>
      </div>
    </div>
  </section>

  <section class="dp-band">
    <div class="dp-band-inner">
      ${eyebrow("How a DealPilot search runs", "ink")}
      <div class="dp-pipeline">
        ${[
          ["01", "Ask", "live", "Nine questions in plain language: condition, make, model, trim, color, mileage, budget, location, radius."],
          ["02", "Scan", "live", "Connected dealer feeds in your radius get queried and normalized onto one spec sheet."],
          ["03", "Read", "live", "A written read on the set: where the price spread is, which listings are aging, what to anchor against."],
          ["04", "Negotiate", "in build", "Out-the-door targets, offers sent on your behalf, counteroffers judged against real transaction data."],
        ].map(([n, t, s, d]) => `<article class="dp-stage">
          <div class="dp-stage-top"><span class="dp-mono dp-stage-n">${n}</span>
            <span class="dp-mono dp-status ${s === "live" ? "is-live" : "is-soon"}">${s}</span></div>
          <h3 class="dp-display dp-stage-t">${t}</h3><p>${d}</p></article>`).join("")}
      </div>
    </div>
  </section>

  <section class="dp-specband">
    <div class="dp-specband-inner">
      <div>
        ${eyebrow("Every listing, same sheet")}
        <h2 class="dp-display dp-h2">Dealers describe cars differently on purpose.</h2>
        <p class="dp-lede">One listing buries the mileage, another hides the drivetrain, a third quotes a price that
          assumes six rebates you don't qualify for. DealPilot pulls the same thirteen fields off every car and puts
          them in the same place. If a car misses something you asked for, the card says so on its face.</p>
        <button class="dp-btn dp-btn-primary" data-action="start">Start your search →</button>
      </div>
      <ul class="dp-fieldlist dp-mono">
        ${["VIN", "Stock number", "Dealer", "Distance", "Condition", "MSRP", "Asking price", "Mileage",
           "Engine", "Drivetrain", "Transmission", "Exterior color", "Interior color"]
          .map((f, i) => `<li><span class="dp-fieldlist-n">${String(i + 1).padStart(2, "0")}</span>${f}</li>`).join("")}
      </ul>
    </div>
  </section>`;
}

function intakeHTML() {
  const step = currentStep();
  const opts = step ? step.options(state.criteria) : [];
  const total = activeSteps().length;

  return `<div class="dp-intake">
    <div class="dp-intake-grid">
      <section class="dp-chat">
        <div class="dp-chat-head">
          <button class="dp-back dp-mono" data-action="back">← Back</button>
          <span class="dp-mono dp-muted">Question ${Math.min(state.stepIndex + 1, total)} of ${total}</span>
        </div>
        <div class="dp-chat-scroll" id="chat-scroll">
          ${state.messages.map((m) => `<div class="dp-bubble ${m.role === "agent" ? "dp-bubble-agent" : "dp-bubble-user"}">${esc(m.text)}</div>`).join("")}
        </div>
        ${step ? `<div class="dp-answer">
          <div class="dp-chips">${opts.map((o) => chip(o.label, {
            value: typeof o.value === "object" ? JSON.stringify(o.value) : o.value, swatch: o.swatch, action: "answer",
          })).join("")}</div>
          <form class="dp-input-row" data-action="answer-text">
            <input class="dp-input" id="answer-input" autocomplete="off"
              placeholder="${esc(step.freeTextHint ? "Type your answer — " + step.freeTextHint : "Or type your answer")}"
              aria-label="Type your answer" />
            <button class="dp-btn dp-btn-primary dp-send" type="submit" aria-label="Send">→</button>
          </form>
        </div>` : ""}
      </section>

      <aside class="dp-sheet">
        <div class="dp-sheet-head dp-mono"><span>BUILD SHEET</span><span class="dp-muted">DRAFT</span></div>
        <dl class="dp-sheet-list dp-mono">
          ${SHEET_ROWS.map(([k, label]) => {
            const v = sheetValue(k);
            return `<div class="dp-sheet-row${v ? " is-set" : ""}"><dt>${label}</dt>
              <dd>${v ? esc(v) : '<span class="dp-sheet-blank">—</span>'}</dd></div>`;
          }).join("")}
        </dl>
        <div class="dp-sheet-foot dp-mono dp-muted">
          These answers become the query sent to every connected inventory source.
          Make, model and trim are enforced exactly.
        </div>
      </aside>
    </div>
  </div>`;
}

function searchingHTML() {
  return `<div class="dp-searching">
    <div class="dp-spinner" aria-hidden="true"></div>
    <h2 class="dp-display dp-h2">Reading the lot</h2>
    <ul class="dp-mono dp-searchlines">
      <li>Opening connections to inventory feeds</li>
      <li>Filtering to ${state.criteria.radiusMi} miles of ${esc(state.criteria.location || "your area")}</li>
      <li>Enforcing exact make, model and trim</li>
      <li>Normalizing listings onto one spec sheet</li>
    </ul>
  </div>`;
}

function resultsHTML() {
  const c = state.criteria;

  if (state.searchError) {
    return `<div class="dp-results"><div class="dp-empty">
      <h3 class="dp-display">The live inventory lookup failed.</h3>
      <p class="dp-mono dp-muted">${esc(state.searchError)}</p>
      <p>Nothing is shown rather than showing you sample cars you might mistake for real ones.
         Check the API key in your Netlify environment variables, then try again.</p>
      <button class="dp-btn dp-btn-primary" data-action="home">Start over</button>
    </div></div>`;
  }

  const visible = [...applyFilters(state.results, state.filters)].sort(SORTS[state.sort].fn);
  const title = [
    c.condition && c.condition !== "Any" ? c.condition : null,
    c.make && c.make !== "Any" ? c.make : null,
    c.model && c.model !== "Any" ? c.model : "vehicles",
    c.trim && c.trim !== "Any" ? c.trim : null,
  ].filter(Boolean).join(" ");

  const drivetrains = [...new Set(state.results.map((v) => v.drivetrain).filter(Boolean))].sort();
  const colorGroups = [...new Set(state.results.map((v) => v.exteriorColor?.group).filter(Boolean))].sort();
  const maxPrice = state.results.length ? Math.ceil(Math.max(...state.results.map((v) => v.price)) / 1000) * 1000 : 100000;

  return `<div class="dp-results">
    <div class="dp-results-head">
      ${eyebrow(`${visible.length} of ${state.results.length} matches shown`)}
      <h1 class="dp-display dp-h2">${esc(title)}</h1>
      <p class="dp-mono dp-muted dp-results-sub">
        Within ${c.radiusMi} mi of ${esc(c.location || "you")}${c.budgetMax ? ` · ceiling ${money(c.budgetMax)}` : ""}
        <button class="dp-textlink" data-action="start">Edit search</button>
      </p>
    </div>

    ${state.relaxed.length ? `<div class="dp-relaxed">
      <strong class="dp-display">No exact match for what you asked.</strong>
      <p>Nothing in range met every requirement, so this set had ${state.relaxed.map((r) => `<b>${esc(r.label)}</b>`).join(" and ")}
      relaxed to find near-misses. Each card is flagged with exactly what differs from your request.</p>
    </div>` : ""}

    <section class="dp-read">
      <div class="dp-read-rail" aria-hidden="true"></div>
      <div class="dp-read-body">
        <div class="dp-read-head dp-mono">PILOT'S READ
          <span class="dp-muted">from the ${state.results.length} matching listings${aiService.lastSource === "claude" ? " · claude" : ""}</span></div>
        ${state.summaryLoading ? `<div class="dp-read-loading dp-mono">Reading the set…</div>` : ""}
        ${state.summary ? `
          <h2 class="dp-display dp-read-headline">${esc(state.summary.headline)}</h2>
          ${state.summary.body.map((p) => `<p class="dp-read-p">${esc(p)}</p>`).join("")}
          ${state.summary.priceRead ? `<p class="dp-read-price">${esc(state.summary.priceRead)}</p>` : ""}
          ${state.summary.watchOuts?.length ? `<ul class="dp-read-list">${state.summary.watchOuts.map((w) => `<li>${esc(w)}</li>`).join("")}</ul>` : ""}
        ` : ""}
      </div>
    </section>

    <div class="dp-toolbar">
      <button class="dp-btn dp-btn-ghost dp-mono dp-filter-toggle" data-action="toggle-filters">Filters</button>
      <label class="dp-sort dp-mono">Sort
        <select data-action="sort">
          ${Object.entries(SORTS).map(([k, v]) => `<option value="${k}"${k === state.sort ? " selected" : ""}>${v.label}</option>`).join("")}
        </select>
      </label>
    </div>

    <div class="dp-results-grid">
      <aside class="dp-filters${state.filtersOpen ? " is-open" : ""}">
        <div class="dp-filter-inner">
          <div class="dp-filter-head dp-mono"><span>REFINE</span>
            <button class="dp-textlink" data-action="reset-filters">Reset</button></div>

          <fieldset class="dp-fieldset"><legend class="dp-mono">Max price · ${money(state.filters.priceMax)}</legend>
            <input type="range" class="dp-range" data-action="filter-range" data-key="priceMax"
              min="5000" max="${maxPrice}" step="500" value="${state.filters.priceMax}" /></fieldset>

          <fieldset class="dp-fieldset"><legend class="dp-mono">Max mileage · ${state.filters.mileageMax.toLocaleString()} mi</legend>
            <input type="range" class="dp-range" data-action="filter-range" data-key="mileageMax"
              min="0" max="200000" step="2500" value="${state.filters.mileageMax}" /></fieldset>

          <fieldset class="dp-fieldset"><legend class="dp-mono">Max distance · ${state.filters.distanceMax} mi</legend>
            <input type="range" class="dp-range" data-action="filter-range" data-key="distanceMax"
              min="5" max="200" step="5" value="${state.filters.distanceMax}" /></fieldset>

          <fieldset class="dp-fieldset"><legend class="dp-mono">Condition</legend>
            <div class="dp-chips dp-chips-sm">${["New", "Certified", "Used"].map((x) =>
              chip(x, { value: x, active: state.filters.conditions.includes(x), action: "filter-conditions" })).join("")}</div></fieldset>

          ${drivetrains.length ? `<fieldset class="dp-fieldset"><legend class="dp-mono">Drivetrain</legend>
            <div class="dp-chips dp-chips-sm">${drivetrains.map((x) =>
              chip(x, { value: x, active: state.filters.drivetrains.includes(x), action: "filter-drivetrains" })).join("")}</div></fieldset>` : ""}

          ${colorGroups.length ? `<fieldset class="dp-fieldset"><legend class="dp-mono">Exterior color</legend>
            <div class="dp-chips dp-chips-sm">${colorGroups.map((x) =>
              chip(x, { value: x, active: state.filters.colors.includes(x),
                swatch: EXTERIOR_COLORS.find((e) => e.group === x)?.hex, action: "filter-colors" })).join("")}</div></fieldset>` : ""}
        </div>
      </aside>

      <section>
        ${visible.length === 0
          ? `<div class="dp-empty"><h3 class="dp-display">Your filters removed everything.</h3>
             <p>Price ceiling and distance cut the most. Reset and narrow one at a time.</p>
             <button class="dp-btn dp-btn-primary" data-action="reset-filters">Reset filters</button></div>`
          : `<div class="dp-cards">${visible.map((v) => vehicleCard(v, c, state.saved.includes(v.id))).join("")}</div>`}
      </section>
    </div>
  </div>`;
}

/* -------------------------------------------------------------------- modals ---------- */
function modalHTML() {
  if (!state.modal) return "";
  const { type, vehicle: v } = state.modal;

  const shell = (inner, wide) => `<div class="dp-modal-wrap" data-action="modal-backdrop">
    <div class="dp-modal${wide ? " is-wide" : ""}" role="dialog" aria-modal="true">
      <button class="dp-modal-close" data-action="close-modal" aria-label="Close">✕</button>${inner}</div></div>`;

  if (type === "auth") {
    return shell(`
      ${eyebrow("Save your search")}
      <h2 class="dp-display dp-modal-title">Sign in to keep this list</h2>
      <p class="dp-modal-sub">Searching is open to everyone. An account is what lets you save vehicles, get
        price-drop alerts, and — when it ships — send offers.</p>
      <div class="dp-auth-stack">
        <button class="dp-auth-btn" data-action="signin" data-provider="google">Continue with Google</button>
        <button class="dp-auth-btn" data-action="signin" data-provider="apple">Continue with Apple</button>
        <div class="dp-auth-divider dp-mono"><span>or</span></div>
        <input class="dp-input" type="email" id="auth-email" placeholder="you@email.com" aria-label="Email address" />
        <button class="dp-btn dp-btn-primary dp-btn-block" data-action="signin" data-provider="email">Send me a sign-in link</button>
      </div>
      <p class="dp-mono dp-muted dp-auth-note">Placeholder auth — no credentials leave this page.
        Live providers connect at authService in js/services.js.</p>`);
  }

  if (type === "lead") {
    return shell(`
      ${eyebrow(`Stock ${v.stockNumber || "—"}`)}
      <h2 class="dp-display dp-modal-title">Check availability</h2>
      <p class="dp-modal-sub">${esc(`${v.year} ${v.make} ${v.model} ${v.trim || ""}`)} · ${money(v.price)} · ${esc(v.dealer.name)}</p>
      ${v.isMock ? `<div class="dp-warn dp-mono">This is sample data. Nothing will be sent to anyone.</div>` : ""}
      <div class="dp-form">
        <label><span class="dp-mono">Name</span><input class="dp-input" id="lead-name" value="${esc(state.user?.name || "")}" /></label>
        <label><span class="dp-mono">Email</span><input class="dp-input" id="lead-email" type="email" value="${esc(state.user?.email || "")}" /></label>
        <label><span class="dp-mono">Phone (optional)</span><input class="dp-input" id="lead-phone" /></label>
        <label><span class="dp-mono">Message</span><textarea class="dp-input dp-textarea" id="lead-message" rows="4">Is the ${esc(`${v.year} ${v.make} ${v.model} ${v.trim || ""}`)} (stock ${esc(v.stockNumber || "")}) still available? Please send the out-the-door price including all fees.</textarea></label>
      </div>
      <button class="dp-btn dp-btn-primary dp-btn-block" data-action="send-lead">Send to dealer</button>
      <p class="dp-mono dp-muted dp-auth-note">[PLUG:LEAD-GEN] Posts to /.netlify/functions/lead-submit, which
        currently logs and returns ok. TCPA consent language attaches here before launch.</p>`);
  }

  if (type === "detail") {
    const rows = [
      ["VIN", v.vin], ["Stock number", v.stockNumber], ["Condition", v.condition], ["Body style", v.bodyStyle],
      ["Mileage", v.mileage < 100 ? "New" : `${v.mileage.toLocaleString()} mi`],
      ["Engine", v.engine], ["Drivetrain", v.drivetrain], ["Transmission", v.transmission],
      ["Exterior", v.exteriorColor?.name], ["Interior", v.interiorColor?.name],
      ["MSRP", v.msrp ? money(v.msrp) : "not listed"], ["Asking", money(v.price)],
      ["Dealer", `${v.dealer.name} · ${v.dealer.city || ""} ${v.dealer.state || ""}`],
      ["Distance", `${v.dealer.distanceMi} mi`], ["Days on lot", v.listedDaysAgo || "—"],
      ["Source feed", v.providerId || "—"],
    ];
    return shell(`
      ${vehicleArt(v, 210)}
      ${eyebrow(`${v.condition} · Stock ${v.stockNumber || "—"}`)}
      <h2 class="dp-display dp-modal-title">${esc(`${v.year} ${v.make} ${v.model} ${v.trim || ""}`)}</h2>
      <dl class="dp-detail-spec dp-mono">
        ${rows.map(([k, val]) => `<div><dt>${esc(k)}</dt><dd>${esc(val ?? "—")}</dd></div>`).join("")}
      </dl>
      ${v.vdpUrl ? `<a class="dp-btn dp-btn-ghost dp-btn-block" href="${esc(v.vdpUrl)}" target="_blank" rel="noopener">View the dealer's listing</a>` : ""}
      <!-- [PLUG:NEGOTIATION] Phase 2 renders price intel here: invoice estimate,
           regional transaction spread, incentives, recommended out-the-door target. -->
      <div class="dp-locked dp-mono">Price intel and offer building unlock in phase 2</div>
      <button class="dp-btn dp-btn-primary dp-btn-block" data-action="lead" data-id="${esc(v.id)}">Check availability</button>`, true);
  }
  return "";
}

/* -------------------------------------------------------------------- render ---------- */
function render() {
  const screens = { landing: landingHTML, intake: intakeHTML, searching: searchingHTML, results: resultsHTML };
  $("#screen").innerHTML = screens[state.screen]();

  $("#nav-right").innerHTML = `
    ${state.screen !== "landing" ? `<button class="dp-nav-link dp-mono" data-action="home">New search</button>` : ""}
    ${state.user && state.saved.length ? `<span class="dp-nav-link dp-mono">${state.saved.length} saved</span>` : ""}
    ${state.user
      ? `<button class="dp-avatar dp-mono" data-action="signout" title="Sign out">${esc(state.user.name.slice(0, 2).toUpperCase())}</button>`
      : `<button class="dp-btn dp-btn-ghost dp-mono" data-action="open-auth">Sign in</button>`}`;

  $("#modal-root").innerHTML = modalHTML();
  updateSourceBanner();
  const scroll = $("#chat-scroll");
  if (scroll) scroll.scrollTop = scroll.scrollHeight;
}

/* The banner is the fix for the "non-existent dealership" problem: whenever the
   listings on screen are not live, the page says so before you read a card. */
function updateSourceBanner() {
  const el = $("#source-banner");
  const foot = $("#footer-source");
  const src = state.source;

  if (state.screen === "results" && src === "mock") {
    el.hidden = false;
    el.className = "dp-databanner is-sample";
    el.innerHTML = state.liveError
      ? `<span class="dp-mono"><b>SAMPLE DATA</b> — the live inventory lookup failed, so these fictional listings
         are being shown instead. Provider said: <code>${esc(state.liveError)}</code></span>`
      : `<span class="dp-mono"><b>SAMPLE DATA</b> — these dealers, VINs and stock numbers are fictional.
         Connect an inventory API key in Netlify and set <code>dataSource: 'live'</code> in js/config.js to search real listings.</span>`;
  } else if (state.screen === "results" && src && src !== "mock" && src !== "error") {
    el.hidden = false;
    el.className = "dp-databanner is-live";
    el.innerHTML = `<span class="dp-mono">LIVE INVENTORY · source: ${esc(src)}</span>`;
  } else {
    el.hidden = true;
  }
  foot.textContent = src === "mock"
    ? "Running on sample data — see README for connecting a live inventory API."
    : src ? `Live inventory via ${src}.` : "";
}

/* ---------------------------------------------------------------------- flow ---------- */
function startIntake(seedCondition) {
  state.criteria = { ...EMPTY_CRITERIA };
  state.stepIndex = 0;
  state.messages = [];
  state.results = []; state.relaxed = []; state.summary = null; state.source = null; state.searchError = null;

  const steps = activeSteps();
  if (seedCondition) {
    state.criteria.condition = seedCondition;
    const label = steps[0].options(state.criteria).find((o) => o.value === seedCondition)?.label || seedCondition;
    state.messages = [
      { role: "agent", text: resolve(steps[0].prompt, state.criteria) },
      { role: "user", text: label },
      { role: "agent", text: resolve(activeSteps()[1].prompt, state.criteria) },
    ];
    state.stepIndex = 1;
  } else {
    state.messages = [{ role: "agent", text: resolve(steps[0].prompt, state.criteria) }];
  }
  state.screen = "intake";
  analytics.track("intake_started", { seedCondition });
  render();
}

function answer(step, value, label) {
  const c = state.criteria;
  if (step.key === "budget") { c.budgetMin = value.budgetMin; c.budgetMax = value.budgetMax; }
  else c[step.field] = value;

  if (step.key === "make") { c.model = null; c.trim = null; }
  if (step.key === "location") c.zip = zipFrom(value);

  state.messages.push({ role: "user", text: label });

  const steps = activeSteps();
  const idx = steps.findIndex((s) => s.key === step.key);
  const next = steps[idx + 1];
  if (next) {
    state.messages.push({ role: "agent", text: resolve(next.prompt, c) });
    state.stepIndex = idx + 1;
    render();
  } else {
    runSearch();
  }
}

async function runSearch() {
  state.screen = "searching";
  render();
  analytics.track("search_submitted", state.criteria);

  const out = await inventoryService.search(state.criteria);
  state.results = out.results;
  state.relaxed = out.relaxed || [];
  state.source = out.source;
  state.searchError = out.error || null;
  state.liveError = out.liveError || null;
  state.sort = "match";
  state.filters = defaultFilters();
  state.screen = "results";
  state.summary = null;
  state.summaryLoading = !state.searchError;
  render();

  if (state.searchError) return;
  state.summary = await aiService.summarize(state.criteria, state.results, state.relaxed);
  state.summaryLoading = false;
  render();
}

function defaultFilters() {
  const prices = state.results.map((v) => v.price);
  const c = state.criteria;
  return {
    priceMax: c.budgetMax ? Math.round(c.budgetMax * 1.1) : (prices.length ? Math.ceil(Math.max(...prices) / 1000) * 1000 : 100000),
    mileageMax: c.maxMileage ? Math.round(c.maxMileage * 1.15) : 200000,
    distanceMax: Math.max(c.radiusMi || 50, ...(state.results.map((v) => v.dealer.distanceMi) || [0])),
    conditions: [], drivetrains: [], colors: [],
  };
}

/* -------------------------------------------------------------------- events ---------- */
document.addEventListener("click", async (e) => {
  const t = e.target.closest("[data-action]");
  if (!t) return;
  const a = t.dataset.action;

  if (a === "modal-backdrop" && e.target !== t) return;

  switch (a) {
    case "home":
      state.screen = "landing"; state.criteria = { ...EMPTY_CRITERIA };
      state.results = []; state.summary = null; state.source = null; render(); break;

    case "start": startIntake(); break;
    case "start-with": startIntake(t.dataset.value); break;
    case "back":
      if (state.stepIndex === 0) { state.screen = "landing"; }
      else { state.stepIndex -= 1; state.messages = state.messages.slice(0, -2); }
      render(); break;

    case "answer": {
      const step = currentStep(); if (!step) break;
      let raw = t.dataset.value;
      let value = step.key === "budget" ? JSON.parse(raw) : raw;
      if (["maxMileage", "radiusMi"].includes(step.field)) value = Number(raw);
      answer(step, value, t.dataset.label); break;
    }

    case "toggle-filters": state.filtersOpen = !state.filtersOpen; render(); break;
    case "reset-filters": state.filters = defaultFilters(); render(); break;

    case "filter-conditions": case "filter-drivetrains": case "filter-colors": {
      const key = a.replace("filter-", "");
      const val = t.dataset.value;
      const list = state.filters[key];
      state.filters[key] = list.includes(val) ? list.filter((x) => x !== val) : [...list, val];
      render(); break;
    }

    case "save": {
      if (!state.user) { state.modal = { type: "auth" }; render(); break; }
      const id = t.dataset.id;
      state.saved = state.saved.includes(id) ? state.saved.filter((x) => x !== id) : [...state.saved, id];
      render(); break;
    }

    case "detail": state.modal = { type: "detail", vehicle: byId(t.dataset.id) }; render(); break;
    case "lead": state.modal = { type: "lead", vehicle: byId(t.dataset.id) }; render(); break;
    case "open-auth": state.modal = { type: "auth" }; render(); break;
    case "close-modal": case "modal-backdrop": state.modal = null; render(); break;

    case "signin": {
      const p = t.dataset.provider;
      const email = $("#auth-email")?.value || "";
      if (p === "email" && !email.includes("@")) break;
      state.user = p === "google" ? await authService.signInWithGoogle()
        : p === "apple" ? await authService.signInWithApple()
        : await authService.signInWithEmail(email);
      state.modal = null; render(); break;
    }

    case "signout": await authService.signOut(); state.user = null; state.saved = []; render(); break;

    case "send-lead": {
      const v = state.modal.vehicle;
      await leadService.submit({
        vehicle: v,
        user: { name: $("#lead-name").value, email: $("#lead-email").value, phone: $("#lead-phone").value },
        message: $("#lead-message").value,
      });
      state.modal = null; render();
      alert(`Sent to ${v.dealer.name}. Dealers typically reply within a few hours.`);
      break;
    }
  }
});

document.addEventListener("submit", (e) => {
  const form = e.target.closest('[data-action="answer-text"]');
  if (!form) return;
  e.preventDefault();
  const step = currentStep(); if (!step) return;
  const input = $("#answer-input");
  const text = input.value.trim(); if (!text) return;
  const parsed = parseFreeText(step.key, text, ALL_MAKES, ALL_MODELS);
  answer(step, parsed ?? text, text);
});

document.addEventListener("input", (e) => {
  const t = e.target.closest('[data-action="filter-range"]');
  if (!t) return;
  state.filters[t.dataset.key] = Number(t.value);
  render();
});

document.addEventListener("change", (e) => {
  const t = e.target.closest('[data-action="sort"]');
  if (!t) return;
  state.sort = t.value; render();
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && state.modal) { state.modal = null; render(); }
});

render();
