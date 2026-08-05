/* ============================================================================
   UI — pure render helpers. Take data, return HTML strings. No state.
   ============================================================================ */

import { money, mismatchFlags } from "./domain.js";

export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/* ------------------------------------------------------------- vehicle artwork -------- */
const SHAPES = {
  sedan: {
    body: "M16 118 C20 96 33 87 62 83 L120 51 C134 43 152 40 178 40 L242 40 C268 40 285 46 298 59 L327 85 L366 93 C382 97 388 105 388 115 L388 121 C388 127 384 130 378 130 L26 130 C18 130 14 126 16 118 Z",
    glass: "M133 60 L174 50 L174 80 L120 80 Z M188 50 L240 50 C262 50 274 57 284 68 L295 80 L188 80 Z",
    wheels: [[98, 124, 27], [312, 124, 27]],
  },
  suv: {
    body: "M14 116 C18 92 30 84 58 80 L96 44 C106 36 120 33 146 33 L256 33 C282 33 296 38 308 52 L336 84 L368 92 C383 96 389 104 389 114 L389 121 C389 127 385 130 379 130 L24 130 C16 130 12 125 14 116 Z",
    glass: "M110 54 L166 44 L166 78 L100 78 Z M180 44 L252 44 C272 44 282 50 291 62 L303 78 L180 78 Z",
    wheels: [[96, 124, 29], [314, 124, 29]],
  },
  truck: {
    body: "M14 116 C18 94 30 86 56 82 L92 46 C102 38 116 35 142 35 L216 35 C232 35 240 42 240 58 L240 86 L386 86 C390 86 392 89 392 93 L392 121 C392 127 388 130 382 130 L24 130 C16 130 12 125 14 116 Z",
    glass: "M106 56 L160 46 L160 80 L96 80 Z M174 46 L214 46 C224 46 228 51 228 60 L228 80 L174 80 Z",
    wheels: [[92, 124, 29], [318, 124, 29]],
  },
};

/**
 * Real photo when the feed gives one, stylized paint-accurate silhouette when
 * it doesn't. Roughly 8–15% of real listing volume arrives without usable
 * photography, so this is a production fallback, not just a demo asset.
 */
export function vehicleArt(v, height = 168) {
  if (v.photos && v.photos.length) {
    return `<div class="dp-photo" style="height:${height}px">
      <img class="dp-photo-img" src="${esc(v.photos[0])}" alt="${esc(`${v.year} ${v.make} ${v.model}`)}" loading="lazy"
           onerror="this.closest('.dp-photo').innerHTML='';this.closest('.dp-photo').insertAdjacentHTML('beforeend',this.dataset.fb||'')" />
    </div>`;
  }
  const s = SHAPES[v.bodyStyle] || SHAPES.sedan;
  const paint = v.exteriorColor?.hex || "#8A9096";
  const dark = v.exteriorColor?.group === "Black";
  const gid = `p_${String(v.id).replace(/\W/g, "")}`;
  return `<div class="dp-photo" style="height:${height}px">
    <svg viewBox="0 0 400 168" class="dp-photo-svg" role="img"
         aria-label="${esc(`${v.year} ${v.make} ${v.model} in ${v.exteriorColor?.name || "unlisted colour"}`)}">
      <defs><linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="${paint}"/><stop offset="55%" stop-color="${paint}" stop-opacity="0.92"/>
        <stop offset="100%" stop-color="#000" stop-opacity="${dark ? 0.35 : 0.22}"/>
      </linearGradient></defs>
      <ellipse cx="200" cy="150" rx="176" ry="9" fill="rgba(18,23,28,0.16)"/>
      <path d="${s.body}" fill="url(#${gid})" stroke="rgba(18,23,28,0.35)" stroke-width="1.5"/>
      <path d="${s.glass}" fill="rgba(18,23,28,0.55)"/>
      ${s.wheels.map(([cx, cy, r]) => `<g>
        <circle cx="${cx}" cy="${cy}" r="${r}" fill="#15191E"/>
        <circle cx="${cx}" cy="${cy}" r="${r * 0.58}" fill="#2C333B"/>
        <circle cx="${cx}" cy="${cy}" r="${r * 0.22}" fill="#454E58"/>
      </g>`).join("")}
    </svg>
    <span class="dp-photo-tag dp-mono">NO DEALER PHOTO · RENDER</span>
  </div>`;
}

/* ------------------------------------------------------------------------ chips ------- */
export function chip(label, { value, active, swatch, action = "chip" } = {}) {
  return `<button type="button" class="dp-chip${active ? " is-active" : ""}"
    data-action="${action}" data-value="${esc(value ?? label)}" data-label="${esc(label)}">
    ${swatch ? `<span class="dp-swatch" style="background:${esc(swatch)}"></span>` : ""}${esc(label)}
  </button>`;
}

/* ------------------------------------------------------------------ vehicle card ------ */
export function vehicleCard(v, criteria, isSaved) {
  const flags = mismatchFlags(v, criteria);
  const discount = v.msrp ? v.msrp - v.price : 0;

  return `<article class="dp-card${v.isMock ? " is-sample" : ""}" data-id="${esc(v.id)}">
    <div class="dp-card-photo">
      ${vehicleArt(v)}
      ${v.isMock ? `<span class="dp-sample-stamp dp-mono">SAMPLE DATA</span>` : ""}
      <div class="dp-card-badges dp-mono">
        <span class="dp-badge cond-${esc(String(v.condition).toLowerCase())}">${esc(v.condition)}</span>
        <span class="dp-badge dp-badge-match">${v._score}% match</span>
      </div>
      <button class="dp-save${isSaved ? " is-saved" : ""}" data-action="save" data-id="${esc(v.id)}"
        aria-label="${isSaved ? "Remove from saved" : "Save this vehicle"}" aria-pressed="${!!isSaved}">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="${isSaved ? "currentColor" : "none"}" stroke="currentColor" stroke-width="2">
          <path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 0 0-7.8 7.8l8.8 8.8 8.8-8.8a5.5 5.5 0 0 0 0-7.8z"/></svg>
      </button>
    </div>

    <div class="dp-card-body">
      <h3 class="dp-display dp-card-title">${esc(v.year)} ${esc(v.make)} ${esc(v.model)}</h3>
      <div class="dp-mono dp-card-trim">${esc(v.trim || "Trim not listed")}</div>

      ${flags.length ? `<ul class="dp-flags dp-mono">
        ${flags.map((f) => `<li>${esc(f)}</li>`).join("")}
      </ul>` : ""}

      <div class="dp-card-price">
        <div><span class="dp-mono dp-label">Asking</span><span class="dp-price">${money(v.price)}</span></div>
        <div class="dp-card-msrp dp-mono">
          ${v.msrp ? `<span class="dp-label">MSRP</span> ${money(v.msrp)}` : `<span class="dp-label">MSRP</span> not listed`}
          ${discount > 200 ? `<span class="dp-under">${money(discount)} under</span>` : ""}
          ${discount < -200 ? `<span class="dp-over">${money(-discount)} over</span>` : ""}
        </div>
      </div>

      <dl class="dp-spec dp-mono">
        <div><dt>Mileage</dt><dd>${v.mileage < 100 ? "New" : v.mileage.toLocaleString() + " mi"}</dd></div>
        <div><dt>Engine</dt><dd>${esc(v.engine || "—")}</dd></div>
        <div><dt>Drivetrain</dt><dd>${esc(v.drivetrain || "—")}</dd></div>
        <div><dt>Transmission</dt><dd>${esc(v.transmission || "—")}</dd></div>
        <div><dt>Exterior</dt><dd><span class="dp-swatch" style="background:${esc(v.exteriorColor?.hex || "#888")}"></span>${esc(v.exteriorColor?.name || "—")}</dd></div>
        <div><dt>Interior</dt><dd><span class="dp-swatch" style="background:${esc(v.interiorColor?.hex || "#888")}"></span>${esc(v.interiorColor?.name || "—")}</dd></div>
      </dl>

      <div class="dp-ids dp-mono">
        <span>VIN <b>${esc(v.vin || "—")}</b></span>
        <span>STOCK <b>${esc(v.stockNumber || "—")}</b></span>
      </div>

      <div class="dp-dealer">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M3 21h18M5 21V7l7-4 7 4v14M9 9h.01M9 13h.01M9 17h.01M15 9h.01M15 13h.01M15 17h.01"/></svg>
        <div>
          <div class="dp-dealer-name">${esc(v.dealer.name)}</div>
          <div class="dp-mono dp-muted">${esc(v.dealer.city || "")}${v.dealer.state ? ", " + esc(v.dealer.state) : ""}
            · ${v.dealer.distanceMi} mi${v.dealer.rating ? ` · ${v.dealer.rating}★` : ""}${v.listedDaysAgo ? ` · ${v.listedDaysAgo}d on lot` : ""}</div>
        </div>
      </div>

      <div class="dp-card-actions">
        <!-- [PLUG:LEAD-GEN] -->
        <button class="dp-btn dp-btn-primary dp-btn-sm" data-action="lead" data-id="${esc(v.id)}">Check availability</button>
        <button class="dp-btn dp-btn-ghost dp-btn-sm" data-action="detail" data-id="${esc(v.id)}">Full details</button>
        <!-- [PLUG:NEGOTIATION] enable when CONFIG.features.negotiation flips true -->
        <button class="dp-btn dp-btn-locked dp-btn-sm" disabled title="Negotiation ships in phase 2">Negotiate</button>
      </div>
    </div>
  </article>`;
}

export function eyebrow(text, tone = "amber") {
  return `<div class="dp-eyebrow dp-mono tone-${tone}">${esc(text)}</div>`;
}
