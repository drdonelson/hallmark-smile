# Lucid Smile — landing package (for the lucid terminal)

Drop-in design for the new **lucidroi.com/smile/** product page. Two files:
- `index.html` — the full landing (self-contained HTML/CSS, no build step).
- `lucid-mark.svg` — the LUCID hexagon logo mark (used as header logo + favicon).

Live reference: https://app.lucidroi.com/lucid-landing.html

Rebuild this in the lucidroi.com repo using the real components/CMS — this HTML is the
visual + copy spec, not necessarily the final markup.

## Naming
- Product = **Lucid Smile** (the AI smile simulator).
- Company / umbrella brand = **Lucid ROI / LUCID**.

## Brand tokens (match exactly)
- Logo: `lucid-mark.svg` (hexagonal network mark). Wordmark "LUCID" = **Josefin Sans 300**, letter-spacing `.34em`.
- Headings: **Outfit** (700/800). Body: **Inter**. Do NOT use Syne.
- Colors: bg `#080a12`, deep `#04050a`, ink `#eef2ff`, muted `rgba(230,236,255,.62)`.
  Accents: periwinkle **`#6b8fff`** (`#8facff` light), green **`#0db862`** / `#28d295`.
  Glass cards `rgba(255,255,255,.035)`, hairline `rgba(160,180,230,.12)`.
- Motifs: faint grid overlay + radial periwinkle/green glow; white-pill primary buttons,
  ghost secondary; periwinkle vertical "Schedule a Demo" side tab.
- Imagery: warm, real smiling-people photography (bright against the dark). **No "trusted by" line.**

## Sections (top → bottom)
1. Nav — LUCID logo+wordmark · Why Lucid · How It Works · Lucid Smile · Products▾ · Pricing · Log in · Book a Demo.
2. Hero — "See the smile. Book the case." + Lucid Smile pitch + before/after visual.
3. Why Lucid Smile — numbered value props (real <60s · no image caps · ROI you can see).
4. The Product — before/after + shareable video + tracked lead + white-label; module chips
   (Whitening / Veneers / Straightening / Missing Teeth / Full Makeover).
5. "Two growth vectors" band — **Lucid Smile (acquisition)** beside **Rippl (referrals)** as distinct cards.
6. Pricing — Starter $197 / Growth $297, plus a **Rippl add-on card** ("from $20/referral") → joinrippl.com.
7. Final CTA + footer.

## Integration must-keeps
- Keep the embedded live simulator demo (the app.lucidroi.com iframe) and the real booking/lead CTAs.
- Products nav + footer link Rippl → https://joinrippl.com.
- Do NOT touch the simulator app, dashboard, or backend — marketing page only.

## Rippl (add-on context)
Automated referral-rewards SaaS (separate product). Detects when a patient refers someone new
and auto-rewards them. Present as a named add-on, own identity, links to joinrippl.com. Not a feature tab.
