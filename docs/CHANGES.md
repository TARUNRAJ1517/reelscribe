# ReelScribe repair build

## Removed

- `public/Tarclips-dashboard.html` (duplicate clip dashboard)
- `public/clips-dashboard.htmlaha` (duplicate/accidental dashboard copy)
- `public/1sitemap.xml` (duplicate sitemap)
- `public/build.sh` (duplicate build script)
- `public/readme.txt`, `public/DEPLOY.txt`, `public/README-REFERRAL.txt` (documentation moved to `docs/`)
- nested `reelscribe-updated.zip`

## Added

- `public/blog/repurpose-youtube-into-reels.html`
- `public/blog/top-10-viral-hooks.html`
- `public/assets/og-cover.png`
- `docs/CHANGES.md`
- page-specific cached CSS/JS under `public/assets/css/` and `public/assets/js/`

## Backend fixes

- Admin credit endpoint now supports add, deduct, exact-set and reset.
- Admin user control now supports suspend, unsuspend and account deletion.
- Added admin user detail endpoint.
- Added server-side user filters and accurate effective-plan handling.
- Added referral review queue APIs with approve/reject actions.
- Preserved `lastPaidPlan` for win-back/churn analytics.
- Payment verification is authenticated, account-bound and idempotent.
- Payment signatures use a timing-safe comparison.
- Payment receipts use a collision-resistant suffix.
- Added secure handling when admin/internal secrets are missing.
- Suspended users are blocked by authenticated APIs.
- `lastActiveAt` is maintained for authenticated activity.
- Clip status is authenticated and owner-scoped.
- Backend YouTube/Instagram URL validation is stricter.
- Removed public debug/test endpoints and the unused unauthenticated proxy upload route.
- Guest preview counters use hashed IPs and an atomic limit check.
- Added basic security response headers and a minimal `/health` endpoint.

## Content/UX fixes

- Removed unsupported TikTok/X/Facebook claims from the transcript page.
- Corrected guest preview wording from 5 full transcripts to 3 previews.
- Removed unsupported competitor-price, rating and fabricated testimonial claims.
- Corrected direct-upload limit messaging to 25 MB.
- Added real blog pages for links that previously returned 404.
- Added private-page exclusions to `robots.txt` and updated the sitemap.
- Optimized the favicon and demo video for a smaller public payload.
