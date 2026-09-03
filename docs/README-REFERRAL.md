# ReelScribe referral system

## Rule

A genuine referred account that completes a meaningful first transcript can unlock one Starter-equivalent clip cut for the referrer. Referral cuts are separate from normal plan clip limits and are watermarked by the EC2 renderer.

Rewards are capped at 5 credited referrals per calendar month.

## Anti-abuse signals

Referral records use one-way hashes for IP/device signals. Suspicious same-IP referrals are placed in `pending_review` instead of being credited automatically.

## Admin review

The Admin → Users area contains a Referral Review Queue. Admins can approve or reject `pending_review` referrals. Approval is atomic and respects the monthly reward cap.

## Public endpoints

- `/ref/CODE` — referral landing/capture.
- `/referral` — authenticated referral dashboard API.

Never place production API keys or `.env` values inside the public directory.
