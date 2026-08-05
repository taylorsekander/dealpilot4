/* ============================================================================
   CONFIG — the one file you edit to go live.
   ============================================================================

   dataSource
     'mock'  → seeded sample listings, generated in the browser. No network.
               Dealers, VINs and stock numbers are FICTIONAL. The app says so
               loudly on screen whenever this mode is active.
     'live'  → calls /.netlify/functions/inventory-search, which calls a real
               provider using a key held server-side.
     'auto'  → tries live, falls back to mock if the function returns an error
               (useful while you're still waiting on API approval).

   You can also override per-visit for testing without redeploying:
     https://yoursite.netlify.app/?data=live
     https://yoursite.netlify.app/?data=mock
   ============================================================================ */

const urlOverride = new URLSearchParams(location.search).get("data");

export const CONFIG = {
  // ── FLIP THIS TO 'live' ONCE YOUR API KEY IS SET IN NETLIFY ──────────────
  dataSource: urlOverride || "auto",

  // Which upstream provider the Netlify function should call.
  // 'autodev'     — auto.dev, 1,000 free calls/month, simplest to start with.
  // 'marketcheck' — MarketCheck, larger dealer coverage, paid.
  // Set via the INVENTORY_PROVIDER env var in Netlify; this is only the hint
  // sent from the client so you can A/B without redeploying.
  provider: null,

  // 'local'  → the deterministic analyst written in js/domain.js. No key, no cost.
  // 'claude' → /.netlify/functions/ai-summary, which calls the Anthropic API.
  aiSummary: "auto",

  endpoints: {
    inventorySearch: "/.netlify/functions/inventory-search",
    aiSummary: "/.netlify/functions/ai-summary",
    leadSubmit: "/.netlify/functions/lead-submit",
    vinDecode: "/.netlify/functions/vin-decode",
  },

  defaults: {
    radiusMi: 50,
    maxResults: 60,
  },

  // Feature flags. Phase 2 work lands behind these.
  features: {
    negotiation: false,   // [PLUG:NEGOTIATION]
    savedSearches: false, // [PLUG:PERSISTENCE]
    priceAlerts: false,
  },
};
