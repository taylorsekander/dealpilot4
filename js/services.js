/* ============================================================================
   SERVICE ADAPTERS (client side)

   Every external dependency lives behind one of these. Screens never fetch.

   The live path always goes through a Netlify Function, never straight to the
   provider. Two reasons, both non-negotiable:
     1. API keys must not ship in browser JS. Anything in /js/ is public.
     2. Providers set CORS for server-to-server use; a browser call is blocked.
   ============================================================================ */

import { CONFIG } from "./config.js";
import { MOCK_INVENTORY } from "./mock-inventory.js";
import { searchWithRelaxation, scoreVehicle, buildLocalSummary } from "./domain.js";

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ INVENTORY ---------- */
export const inventoryService = {
  /** Reports which source actually served the last search. Drives the banner. */
  lastSource: null,
  lastError: null,

  /**
   * search(criteria) → { results, relaxed, source, meta }
   *
   * results[] are normalized. The normalization happens server-side in
   * netlify/functions/inventory-search.mjs so that swapping providers never
   * touches client code.
   */
  async search(criteria) {
    const mode = CONFIG.dataSource;

    if (mode !== "mock") {
      try {
        const res = await fetch(CONFIG.endpoints.inventorySearch, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ criteria, provider: CONFIG.provider }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || `inventory-search returned ${res.status}`);
        if (!Array.isArray(data.results)) throw new Error("malformed response");

        this.lastSource = data.source || "live";
        this.lastError = null;
        // Relaxation runs client-side on the returned set too, because a
        // provider may return loose matches on trim regardless of what we ask.
        const { results, relaxed } = searchWithRelaxation(data.results, criteria);
        return {
          results: results.map((v) => ({ ...v, _score: scoreVehicle(v, criteria) })),
          relaxed, source: this.lastSource, meta: data.meta || {},
        };
      } catch (err) {
        this.lastError = err.message;
        if (mode === "live") {
          // Explicit live mode: fail loudly. Never quietly serve fake cars to
          // someone who believes they are looking at real inventory.
          return { results: [], relaxed: [], source: "error", error: err.message, meta: {} };
        }
        // mode === 'auto': fall through to sample data, clearly labelled.
        console.warn("[inventory] live lookup failed, using sample data:", err.message);
      }
    }

    await delay(700);
    this.lastSource = "mock";
    const { results, relaxed } = searchWithRelaxation(MOCK_INVENTORY, criteria);
    return {
      results: results.map((v) => ({ ...v, _score: scoreVehicle(v, criteria) })),
      relaxed, source: "mock",
      meta: { totalScanned: MOCK_INVENTORY.length, note: this.lastError || null },
      liveError: this.lastError || null,
    };
  },

  /** Free NHTSA decode — no key needed. Used on the details drawer. */
  async decodeVin(vin) {
    const res = await fetch(`${CONFIG.endpoints.vinDecode}?vin=${encodeURIComponent(vin)}`);
    if (!res.ok) throw new Error("VIN decode failed");
    return res.json();
  },
};

/* ------------------------------------------------------------------------ AUTH --------- */
/**
 * [PLUG:AUTH] Still placeholder. Identity is held in memory for this session only.
 *
 * To make it real, the recommended path on Netlify is Auth0, Clerk, or Supabase
 * Auth — all three give you Google and Apple with one integration and handle the
 * parts that are easy to get wrong:
 *   · Google — verify the ID token server-side (check aud and iss). Never trust
 *     a token the browser hands you.
 *   · Apple  — handles private-relay addresses, and note Apple returns the
 *     user's NAME ONLY on first authorization. Capture it then or lose it.
 *   · Email  — magic link or OTP. Do not ship a password field for this product.
 *
 * Session belongs in an httpOnly, SameSite=Lax cookie set by your backend.
 * Provider tokens stay server-side. Nothing sensitive in localStorage.
 */
export const authService = {
  async signInWithGoogle() { await delay(600); return { id: "u_g", name: "Demo Driver", email: "demo@gmail.com", provider: "google" }; },
  async signInWithApple()  { await delay(600); return { id: "u_a", name: "Demo Driver", email: "demo@privaterelay.appleid.com", provider: "apple" }; },
  async signInWithEmail(email) { await delay(600); return { id: "u_e", name: email.split("@")[0], email, provider: "email" }; },
  async signOut() { await delay(100); return true; },
};

/* -------------------------------------------------------------------------- AI --------- */
export const aiService = {
  lastSource: "local",

  /**
   * [PLUG:AI] Tries the Claude-backed function when configured, and always falls
   * back to the local analyst. A plain read beats no read.
   */
  async summarize(criteria, results, relaxed) {
    if (CONFIG.aiSummary !== "local") {
      try {
        const res = await fetch(CONFIG.endpoints.aiSummary, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ criteria, relaxed, results: results.slice(0, 25) }),
        });
        if (res.ok) {
          const data = await res.json();
          if (data && data.headline) { this.lastSource = "claude"; return data; }
        }
      } catch (err) {
        console.warn("[ai] summary call failed, using local analyst:", err.message);
      }
    }
    this.lastSource = "local";
    await delay(250);
    return buildLocalSummary(criteria, results, relaxed);
  },
};

/* ------------------------------------------------------------------------ LEADS -------- */
/**
 * [PLUG:LEAD-GEN] This is the revenue path. The function it posts to currently
 * logs and returns ok. To make it real:
 *   · Persist the lead on your side FIRST. The dealer POST is best-effort and
 *     must retry from a queue, never inline with the user's click.
 *   · Format an ADF/XML lead — still the lingua franca of automotive CRMs —
 *     or push directly to VinSolutions / Elead / DealerSocket.
 *   · Store providerId, dealerId, vehicleId and the originating search. Without
 *     attribution there is no billing.
 *   · TCPA: consent language on the form, honor DNC, log the consent text and
 *     timestamp with the lead.
 */
export const leadService = {
  async submit({ vehicle, user, message }) {
    try {
      const res = await fetch(CONFIG.endpoints.leadSubmit, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          vehicleId: vehicle.id, vin: vehicle.vin, stockNumber: vehicle.stockNumber,
          dealerId: vehicle.dealer.id, dealerName: vehicle.dealer.name,
          user, message, isMock: !!vehicle.isMock,
        }),
      });
      return res.ok ? res.json() : { ok: false };
    } catch {
      return { ok: false };
    }
  },
};

/* ----------------------------------------------------------- NEGOTIATION (phase 2) ----- */
/**
 * [PLUG:NEGOTIATION] Nothing wired yet beyond a disabled affordance on each card.
 * Planned surface:
 *   getPriceIntel(vehicle)   → invoice estimate, regional transaction spread,
 *                              days on lot, incentives the buyer qualifies for.
 *   buildOffer(vehicle, ctx) → an out-the-door target: price + doc fee + tax +
 *                              title/reg, with a walk-away number and reasoning.
 *   sendOffer(offer)         → deliver and track (sent → countered → accepted).
 *   evaluateCounter(counter) → accept / counter / walk, reasoning shown to buyer.
 *
 * Design constraint worth writing down: DealPilot represents the BUYER. Keep
 * this service independent of leadService and never let dealer payouts affect
 * ranking, or the negotiation product loses the trust it depends on.
 */
export const negotiationService = { isEnabled: false };

/* -------------------------------------------------------------------- ANALYTICS -------- */
/** [PLUG:ANALYTICS] Swap for Segment / Amplitude / a warehouse sink. */
export const analytics = {
  track(event, props = {}) { console.info("[analytics]", event, props); },
};
