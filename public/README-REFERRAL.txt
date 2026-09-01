ReelScribe Referral + Responsive Update

PUBLIC
- All responsive public pages are in public/.
- referral.html uses /referral and /ref/CODE.
- dashboard.html and clips-dashboard.html include referral UI.

RENDER BACKEND
- server.js: referral capture + first-transcript reward + /referral API + referral-aware clip routing.
- models/User.js: referral fields.
- models/Referral.js: referral records/status.
- Keep the existing .env and all other existing models/services.

EC2 BACKEND
- reelscribe-clip-server/server.js accepts referralCut/watermark.
- clipService.js applies a subtle ReelScribe watermark to referral cuts.
- Other EC2 JS files are included from the current referral backend package.

REFERRAL RULE
One genuine referred account completing its first transcript can unlock one Starter-equivalent clip cut for the referrer. Referral cuts are separate from normal plan clip limits and are watermarked. Rewards are capped at 5 credited referrals per calendar month.

DEPLOYMENT
1. Backup current files.
2. Render: replace server.js + User.js, add Referral.js. Keep existing env and other backend files.
3. EC2: replace the corresponding reelscribe-clip-server files.
4. Public: copy public/*.html to the existing public directory.
5. Restart the relevant PM2 processes.

Never upload/replace production .env from this package.
