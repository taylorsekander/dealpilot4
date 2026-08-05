/* ============================================================================
   Platform-neutral core. Wrapped by netlify/functions/* and functions/api/*.
   Takes (request, env) and returns a Response — works on Node and on Workers.
   Do NOT reference process.env in here; env is passed in by the wrapper.

   [PLUG:LIVE-INVENTORY]  POST /api/inventory-search

   This is the seam between DealPilot and the real world. The browser never
   talks to a provider directly — API keys would be public and providers block
   browser origins anyway.

   Supported providers (pick with the INVENTORY_PROVIDER env var):
     autodev      api.auto.dev            1,000 free calls/month. Start here.
     marketcheck  api.marketcheck.com     Larger dealer coverage. Paid.

   Environment variables to set in Netlify
   (Site configuration → Environment variables):
     INVENTORY_PROVIDER   autodev | marketcheck
     AUTODEV_API_KEY      your auto.dev key
     MARKETCHECK_API_KEY  your MarketCheck key

   Adding a third provider = one more entry in PROVIDERS below. Nothing in the
   client changes, because every provider returns the SAME normalized shape.
   ============================================================================ */

const NORMALIZED_SHAPE = `
  { id, vin, stockNumber, condition, year, make, model, trim, bodyStyle,
    price, msrp, mileage, engine, drivetrain, transmission,
    exteriorColor:{name,hex,group}, interiorColor:{name,hex},
    dealer:{ id, name, city, state, distanceMi, rating },
    photos:[], vdpUrl, listedDaysAgo, providerId }`;

/* Feeds give colour as free text. Map it to a group so filters and swatches work. */
const COLOR_GROUPS = [
  [/black|ebony|onyx|midnight/i,            "Black",  "#111318"],
  [/white|pearl|ivory|frost/i,              "White",  "#EDEEEA"],
  [/silver|aluminum|platinum/i,             "Silver", "#B6BABD"],
  [/gray|grey|graphite|magnetic|gunmetal/i, "Gray",   "#6B7178"],
  [/blue|navy|cobalt|azure/i,               "Blue",   "#2F5D9E"],
  [/red|ruby|crimson|maroon|burgundy/i,     "Red",    "#9C2029"],
  [/green|forest|jade|sage/i,               "Green",  "#27473B"],
  [/brown|bronze|copper|tan|beige|khaki/i,  "Brown",  "#6B4F35"],
  [/gold|champagne/i,                       "Gold",   "#B99552"],
  [/orange/i,                               "Orange", "#C4611F"],
  [/yellow/i,                               "Yellow", "#D7B024"],
];

function normalizeColor(raw) {
  const name = (raw || "").trim();
  for (const [re, group, hex] of COLOR_GROUPS) {
    if (re.test(name)) return { name: name || group, hex, group };
  }
  return { name: name || "Not listed", hex: "#8A9096", group: "Other" };
}

function bodyStyleOf(raw) {
  const s = (raw || "").toLowerCase();
  if (/truck|pickup|crew cab|super cab/.test(s)) return "truck";
  if (/suv|crossover|wagon|van|minivan/.test(s)) return "suv";
  return "sedan";
}

function conditionOf(raw, certified) {
  if (certified) return "Certified";
  const s = (raw || "").toLowerCase();
  if (s.includes("new")) return "New";
  if (s.includes("certified")) return "Certified";
  return "Used";
}

const daysSince = (iso) => {
  if (!iso) return null;
  const d = Math.round((Date.now() - new Date(iso).getTime()) / 86400000);
  return Number.isFinite(d) && d >= 0 ? d : null;
};

/* ------------------------------------------------------------------ auto.dev ----------
   Parameter names verified against docs.auto.dev/v2/products/vehicle-listings.

   Two things about this API that shape the code below:

   1. It REJECTS unknown parameters with a 400 INVALID_PARAMETER naming the
      offender — it does not ignore them. One wrong name fails the whole request.
      So we send a conservative set, and if it still objects we strip the named
      parameter and retry once. Self-healing beats a dead search.

   2. ?limit= is capped by plan (Starter 20, Growth 100, Scale 500) and clamps
      silently rather than erroring.

   Filters we deliberately do NOT send, because the parameter names aren't
   documented and a wrong guess kills the request: condition (new/used) and
   mileage. Both are enforced client-side in domain.js instead, which costs a
   few wasted rows but never costs a failed search.
------------------------------------------------------------------------------------- */
const autodev = {
  id: "auto.dev",

  buildParams(c) {
    const p = new URLSearchParams();
    if (c.make && c.make !== "Any") p.set("vehicle.make", c.make);
    if (c.model && c.model !== "Any") p.set("vehicle.model", c.model);
    if (c.trim && c.trim !== "Any") p.set("vehicle.trim", c.trim);
    if (c.budgetMax) p.set("retailListing.price", `1-${Math.round(c.budgetMax)}`);

    // Location: top-level `zip` and `distance`. NOT namespaced.
    if (c.zip) {
      p.set("zip", String(c.zip));
      p.set("distance", String(c.radiusMi || 50));
    }
    p.set("limit", "100");
    p.set("sort", "price.asc");
    return p;
  },

  async fetchListings(c, key, diag) {
    let params = this.buildParams(c);

    for (let attempt = 0; attempt < 4; attempt++) {
      const url = `https://api.auto.dev/listings?${params}`;
      diag.attempts.push(url.replace(key, "***"));

      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      });

      if (res.ok) {
        const json = await res.json();
        diag.total = json.total ?? null;
        return Array.isArray(json.data) ? json.data : [];
      }

      const text = await res.text();
      let err = {};
      try { err = JSON.parse(text); } catch { /* non-JSON error body */ }

      // Strip the offending parameter and try again.
      const bad = err.code === "INVALID_PARAMETER" &&
        (err.error || "").match(/Invalid parameter provided:\s*([\w.]+)/)?.[1];
      if (bad && params.has(bad)) {
        diag.warnings.push(`auto.dev rejected "${bad}" — retried without it. Verify the name in their docs.`);
        params.delete(bad);
        continue;
      }
      if (bad) {
        // Named a parameter we can't find (case difference, nested name).
        const guess = [...params.keys()].find((k) => k.toLowerCase().endsWith(bad.toLowerCase()));
        if (guess) {
          diag.warnings.push(`auto.dev rejected "${bad}" (sent as "${guess}") — retried without it.`);
          params.delete(guess);
          continue;
        }
      }
      throw new Error(`auto.dev ${res.status}: ${text.slice(0, 300)}`);
    }
    throw new Error("auto.dev: too many parameter rejections; check filter names against current docs");
  },

  normalize(raw, i) {
    const v = raw.vehicle || {};
    const r = raw.retailListing || {};
    const d = raw.dealer || r.dealer || {};
    const loc = raw.location || {};

    const miles = Number(r.miles ?? r.mileage ?? v.miles) || 0;
    // The API doesn't document a condition filter, so infer it. CPO is documented.
    const condition = r.cpo === true ? "Certified"
      : (r.condition || v.condition || "").toLowerCase().includes("new") ? "New"
      : miles < 200 ? "New" : "Used";

    return {
      id: raw.id || raw.vin || v.vin || `autodev_${i}`,
      isMock: false,
      providerId: "auto.dev",
      vin: raw.vin || v.vin || null,
      stockNumber: r.stockNumber || r.stockNo || null,
      condition,
      year: Number(v.year) || null,
      make: v.make || null,
      model: v.model || null,
      trim: v.trim || v.trimName || null,
      bodyStyle: bodyStyleOf(v.bodyStyle || v.bodyType || v.style),
      price: Number(r.price ?? r.listPrice) || 0,
      msrp: Number(r.msrp ?? v.msrp) || null,
      mileage: miles,
      engine: v.engine || v.engineDescription || v.engineType || null,
      drivetrain: v.drivetrain || v.driveType || null,
      transmission: v.transmission || v.transmissionType || null,
      exteriorColor: normalizeColor(v.exteriorColor || r.exteriorColor),
      interiorColor: normalizeColor(v.interiorColor || r.interiorColor),
      dealer: {
        id: String(d.id || d.dealerId || `d_${i}`),
        name: d.name || d.dealerName || r.sellerName || "Dealer name not provided",
        city: d.city || loc.city || r.city || null,
        state: d.state || loc.state || r.state || null,
        distanceMi: Math.round((Number(raw.distance ?? loc.distance ?? d.distance) || 0) * 10) / 10,
        rating: Number(d.rating) || null,
      },
      photos: raw.photoUrls || raw.photos || (r.primaryPhotoUrl ? [r.primaryPhotoUrl] : []),
      vdpUrl: r.vdpUrl || raw.url || null,
      listedDaysAgo: daysSince(raw.createdAt || r.firstSeenAt),
    };
  },
};

/* --------------------------------------------------------------- MarketCheck ---------- */
const marketcheck = {
  id: "marketcheck",
  async fetchListings(c, key) {
    const p = new URLSearchParams({ api_key: key, rows: "50", start: "0" });
    if (c.make && c.make !== "Any") p.set("make", c.make);
    if (c.model && c.model !== "Any") p.set("model", c.model);
    if (c.trim && c.trim !== "Any") p.set("trim", c.trim);
    if (c.condition === "New") p.set("car_type", "new");
    if (c.condition === "Used") p.set("car_type", "used");
    if (c.condition === "Certified") p.set("car_type", "certified");
    if (c.zip) { p.set("zip", c.zip); p.set("radius", String(c.radiusMi || 50)); }
    if (c.budgetMax) p.set("price_range", `0-${Math.round(c.budgetMax)}`);
    if (c.maxMileage) p.set("miles_range", `0-${Math.round(c.maxMileage)}`);

    const res = await fetch(`https://api.marketcheck.com/v2/search/car/active?${p}`, {
      headers: { Accept: "application/json" },
    });
    if (!res.ok) throw new Error(`marketcheck ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const json = await res.json();
    return json.listings || [];
  },

  normalize(raw, i) {
    const b = raw.build || {};
    const d = raw.dealer || {};
    return {
      id: raw.id || raw.vin || `mc_${i}`,
      isMock: false,
      providerId: "marketcheck",
      vin: raw.vin || null,
      stockNumber: raw.stock_no || null,
      condition: conditionOf(raw.inventory_type, raw.is_certified),
      year: Number(b.year) || null,
      make: b.make || null,
      model: b.model || null,
      trim: b.trim || null,
      bodyStyle: bodyStyleOf(b.body_type || b.vehicle_type),
      price: Number(raw.price) || 0,
      msrp: Number(raw.msrp) || null,
      mileage: Number(raw.miles) || 0,
      engine: b.engine || [b.engine_size && `${b.engine_size}L`, b.cylinders && `${b.cylinders}-cyl`].filter(Boolean).join(" ") || null,
      drivetrain: b.drivetrain || null,
      transmission: b.transmission || null,
      exteriorColor: normalizeColor(raw.exterior_color),
      interiorColor: normalizeColor(raw.interior_color),
      dealer: {
        id: String(d.id || `d_${i}`),
        name: d.name || "Dealer name not provided",
        city: d.city || null,
        state: d.state || null,
        distanceMi: Number(raw.dist) || 0,
        rating: Number(d.dealer_rating) || null,
      },
      photos: raw.media?.photo_links || [],
      vdpUrl: raw.vdp_url || null,
      listedDaysAgo: Number(raw.dom) || null,
    };
  },
};

const PROVIDERS = { autodev, marketcheck };

/* ------------------------------------------------------------------- handler ---------- */
export async function handleInventorySearch(req, env) {
  const url = new URL(req.url);
  let body = {};

  /* ------------------------------------------------------------------ GET debug -----
     Visit this in a browser — no console, no curl:

       /api/inventory-search?debug=1&make=Ford&model=F-150&zip=20147

     Returns the provider's UNTOUCHED first record next to our normalized version,
     plus a field report naming every mapping that came back empty. That report is
     the fastest way to fix a normalizer: it says exactly which guesses were wrong.
  ---------------------------------------------------------------------------------- */
  if (req.method === "GET") {
    const q = url.searchParams;
    if (!q.get("debug")) {
      return json({ error: "POST only, or add ?debug=1 to inspect a live response", normalizedShape: NORMALIZED_SHAPE }, 405);
    }
    body = {
      debug: true,
      provider: q.get("provider") || undefined,
      criteria: {
        make: q.get("make") || undefined,
        model: q.get("model") || undefined,
        trim: q.get("trim") || undefined,
        zip: q.get("zip") || undefined,
        radiusMi: Number(q.get("radius")) || 100,
        budgetMax: Number(q.get("budgetMax")) || undefined,
      },
    };
  } else if (req.method === "POST") {
    try { body = await req.json(); } catch { return json({ error: "invalid JSON body" }, 400); }
  } else {
    return json({ error: "GET or POST only" }, 405);
  }

  const criteria = body.criteria || {};

  const name = body.provider || env.INVENTORY_PROVIDER || "autodev";
  const provider = PROVIDERS[name];
  if (!provider) return json({ error: `unknown provider "${name}"` }, 400);

  const key = name === "autodev" ? env.AUTODEV_API_KEY : env.MARKETCHECK_API_KEY;
  if (!key) {
    return json({
      error: `Missing API key. Set ${name === "autodev" ? "AUTODEV_API_KEY" : "MARKETCHECK_API_KEY"} ` +
             `as an environment variable (Cloudflare: Settings → Variables and Secrets · ` +
             `Netlify: Site configuration → Environment variables), then redeploy.`,
    }, 503);
  }

  // diag travels with the request so the browser can see exactly what was sent.
  // This is what turns "it silently used sample data" into an actionable error.
  const diag = { attempts: [], warnings: [], total: null };

  try {
    const raw = await provider.fetchListings(criteria, key, diag);
    const results = raw.map((r, i) => provider.normalize(r, i)).filter((v) => v.price > 0);

    // Debug view: POST {"debug":true} to see one untouched provider record
    // alongside our normalized version. Use this to fix field mapping fast.
    if (body.debug) {
      const all = raw.map((r, i) => provider.normalize(r, i));
      const n = all[0] || {};
      const empty = (v) => v === null || v === undefined || v === "" || v === 0;

      // Which normalized fields came back empty across the whole page? A field
      // that is empty on EVERY record is a wrong guess, not missing data.
      const alwaysEmpty = [
        "vin", "price", "msrp", "mileage", "trim", "engine", "drivetrain",
        "transmission", "stockNumber",
      ].filter((k) => all.length && all.every((v) => empty(v[k])));
      const dealerAlwaysEmpty = ["name", "city", "state", "distanceMi"]
        .filter((k) => all.length && all.every((v) => empty(v.dealer?.[k])));

      return json({
        source: provider.id,
        diag,
        counts: {
          rawReturned: raw.length,
          normalized: all.length,
          survivedPriceFilter: all.filter((v) => v.price > 0).length,
        },
        fieldReport: {
          alwaysEmpty,
          dealerAlwaysEmpty,
          note: alwaysEmpty.length || dealerAlwaysEmpty.length
            ? "These normalized fields are empty on EVERY record — the source field names differ from what the adapter expects. Compare against rawSample below."
            : "All critical fields mapped successfully.",
        },
        rawTopLevelKeys: raw[0] ? Object.keys(raw[0]) : [],
        rawSample: raw[0] ?? null,
        normalizedSample: n,
      }, 200);
    }

    return json({
      results,
      source: provider.id,
      meta: {
        totalScanned: raw.length,
        returned: results.length,
        providerTotal: diag.total,
        warnings: diag.warnings,
        requests: diag.attempts,
        fetchedAt: new Date().toISOString(),
      },
    });
  } catch (err) {
    console.error("[inventory-search]", err, diag);
    return json({ error: String(err.message || err), diag }, 502);
  }
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}
