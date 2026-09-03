# ReelScribe deployment notes

## Included production structure

- `server.js` — Express API, auth, transcription, clips, payments and admin APIs.
- `models/` — MongoDB models.
- `services/` — S3/FFmpeg helpers.
- `public/` — public website and browser assets.
- `public/blog/` — SEO/content pages linked from the transcript page.
- `docs/` — deployment/reference notes; intentionally outside `public/`.

## Required environment variables

Keep the production `.env` outside this package and configure the existing values for MongoDB, session security, Groq, Google OAuth, Resend, Razorpay, S3, EC2 and the internal/admin secrets.

`SESSION_SECRET`, `ADMIN_SECRET`, and `INTERNAL_SECRET` must not be empty.

## Deploy

1. Back up the current production deployment.
2. Replace the application files with this package.
3. Keep the production `.env`; do not upload secrets from a source archive.
4. Install dependencies with `npm install`.
5. Restart the Render/Node service.
6. Verify `/health`, login, transcription, clip generation and a test payment in the appropriate environments.

## Important

- Direct browser transcript uploads are limited to 25 MB to match the current Groq upload flow and UI.
- Clip processing continues to use the configured EC2 service and `x-internal-key`.
- Generated clip files are still cleaned up by the existing cleanup sweep.
- The old duplicate clip dashboard, duplicate sitemap, nested ZIP and public deployment notes were removed.
