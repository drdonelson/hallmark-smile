# Smile Simulator — Compliance Checklist

**Status: technical controls built and deployed. NOT yet attorney-reviewed. Do not represent the Service as "HIPAA compliant" until the items below are done.**

This file tracks the legal/business steps that engineering cannot complete. The
code provides the *controls*; compliance requires the *agreements and review*.

---

## 1. Attorney review (required before relying on this with real patients)

A healthcare/privacy attorney must review:
- `legal/privacy.html`, `legal/terms.html`, `legal/disclaimer.html`
- The in-app consent wording (`smile-simulator.html`, checkbox `fDisclaimer`)
- This whole architecture against HIPAA, state biometric laws, and dental-board advertising rules.

Search the legal HTML for `REVIEW:` (HTML comments) — each marks a point that needs counsel sign-off.

## 2. Fill-in placeholders (in the legal pages)

| Placeholder | Where | Needs |
|---|---|---|
| `Lucid ROI` exact legal name/form | all pages | e.g. "Lucid ROI LLC" + registered address |
| `[STATE]` governing law + venue | terms.html §14 | the state Lucid operates from |
| Retention window `[30]` days | privacy.html §7 | confirm with practice/counsel (code default = 30d, `MEDIA_TTL_DAYS` in worker.js) |
| `privacy@lucidroi.com` / `support@lucidroi.com` | all | confirm mailboxes exist + monitored |

## 3. Vendor agreements (BAAs) — the HIPAA gate

A face photo is a HIPAA identifier. When a **practice uses this on a real patient**,
the stored media is PHI and every vendor that touches it needs a signed BAA. Current state:

| Vendor | Role | BAA status | Action |
|---|---|---|---|
| Cloudflare (R2/Workers) | media storage + API | Enterprise tier only | Sign Cloudflare BAA **or** move PHI store to S3 (below) |
| Replicate | AI image | No BAA offered | Mitigated: image-only, no name/contact, transient. Counsel to confirm this posture. |
| fal.ai | AI image/video | No BAA offered | Same mitigation as Replicate |
| OpenAI | AI image (fallback) | BAA on eligible API tiers | Sign if PHI path needs it |
| Resend | result/lead email | No standard BAA | Patient name + photo link travel through email → confirm with counsel or switch to a BAA-capable mail provider (e.g. Paubox, AWS SES under BAA) |

**Bottom line:** the public marketing embed (a visitor uploading their own selfie) is
generally **not** HIPAA-regulated and is fine as-is. True end-to-end HIPAA for
chairside patient use is blocked by the AI/email vendors not signing BAAs — the
same constraint every competitor has. Offer practices a BAA "on request" and keep
AI vendors PHI-name-free (already the case).

## 4. HIPAA-mode upgrade path (when a practice contractually requires a BAA)

The storage layer is abstracted in `worker.js` (`storeMedia` / `handleStoredMedia`).
To move the persistent media library to a BAA-covered store:
1. Stand up **AWS S3** (BAA is free via AWS Artifact) — cheapest legitimate option.
2. Reimplement `storeMedia` to `PutObject` to S3 and `handleStoredMedia` to stream from S3 (presigned GET). Keep the `/api/m/<token>` URL shape so nothing else changes.
3. Keep R2 only as the minutes-long processing relay (`r2Upload`) — that's transient and image-only.
Cost: pennies/GB vs. Supabase Team ($599/mo) or Cloudflare Enterprise.

## 5. What the code already does (controls in place)

- **Consent gate**: explicit, itemized consent (AI processing + email-share + cosmetic-not-medical) required before generation; links to all three policies.
- **Consent audit log**: every consent + share recorded to `consent/<date>/<id>.json` (1-yr retention) with timestamp, IP, tenant, version, scope.
- **Short processing retention**: upload relay images auto-expire in 5–10 min.
- **Media library**: 48-hex non-guessable tokens, `noindex`, 30-day auto-expiry, served over TLS, encrypted at rest (R2 default).
- **Client-side biometrics**: facial landmarks computed in-browser; geometry never transmitted (reduces BIPA exposure).
- **Image-only AI calls**: no name/contact sent to Replicate/fal/OpenAI.
- **Watermark**: every result is stamped "✦ AI SIMULATION" so the disclosure travels with downloads and emails.
- **Usage metering + rate limits**: per-tenant monthly caps + per-IP daily caps (incl. shares).
- **Secrets**: `RESEND_API_KEY` must be set as a Cloudflare Worker secret for email to send.

## 6. Operational reminders

- Bump `CONSENT_VERSION` (`smile-simulator.html`) whenever consent wording changes.
- Honor deletion requests: delete the relevant `media/<id>` and `consent/.../<id>.json` objects.
- Keep the subprocessor table in `privacy.html` §6 in sync with the actual stack.
- Before go-live, resolve and remove all `REVIEW:` comments in the legal pages.
