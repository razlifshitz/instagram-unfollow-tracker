# Instagram Unfollow Tracker

Track who unfollowed you on Instagram. Each time you visit the dashboard, it fetches your live follower list, diffs it against the last snapshot, and shows you exactly who left and who's new.

---

## Stack

- **Backend**: Node.js + Express
- **Database**: PostgreSQL (Railway plugin)
- **Auth**: Instagram OAuth via Meta Graph API
- **Frontend**: Vanilla HTML/JS (no framework needed)

---

## Setup

### 1. Clone and install

```bash
git clone <your-repo>
cd instagram-unfollow-tracker
npm install
```

### 2. Configure your Meta App

In your Meta Developer dashboard (developers.facebook.com):

**a) Get your credentials**
Go to **App Settings → Basic** and copy:
- App ID
- App Secret

**b) Add your redirect URI**
Go to **Facebook Login for Business → Settings** and add to "Valid OAuth Redirect URIs":
```
http://localhost:3000/auth/callback
```
Add your Railway URL too once deployed:
```
https://your-app.railway.app/auth/callback
```

**c) Add yourself as a test user**
Go to **App Roles → Roles → Testers** and add your Instagram account.
Then accept the invite at: https://www.facebook.com/settings?tab=applications

### 3. Set up environment variables

```bash
cp .env.example .env
```

Edit `.env` with your values:
```
IG_APP_ID=your_app_id
IG_APP_SECRET=your_app_secret
IG_REDIRECT_URI=http://localhost:3000/auth/callback
SESSION_SECRET=<run: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))">
DATABASE_URL=postgresql://...
```

### 4. Run locally

```bash
# Start a local Postgres first (or use Railway's DB directly):
npm run dev
```

Open http://localhost:3000

---

## Deploy to Railway

### 1. Create a new Railway project

Go to https://railway.app → New Project → Deploy from GitHub repo.

Connect your GitHub account and select this repo.

### 2. Add a Postgres database

Inside your Railway project:
- Click **+ New** → **Database** → **Add PostgreSQL**
- Railway auto-creates a `DATABASE_URL` variable — it's injected into your app automatically.

### 3. Add environment variables

In Railway: go to your service → **Variables** tab → add:

| Key | Value |
|-----|-------|
| `IG_APP_ID` | Your Meta App ID |
| `IG_APP_SECRET` | Your Meta App Secret |
| `IG_REDIRECT_URI` | `https://your-app.railway.app/auth/callback` |
| `SESSION_SECRET` | Random 32-char hex string |
| `NODE_ENV` | `production` |

> `DATABASE_URL` is already set automatically by Railway's Postgres plugin.

### 4. Get your Railway domain

Go to your service → **Settings** → **Networking** → Generate Domain.

Copy the domain (e.g. `https://instagram-tracker-production.up.railway.app`).

### 5. Update your Meta App redirect URI

Back in developers.facebook.com → Facebook Login for Business → Settings:

Add:
```
https://your-app.railway.app/auth/callback
```

### 6. Deploy

Push to your GitHub repo — Railway auto-deploys on every push.

---

## How it works

1. You visit the dashboard → triggers `/api/dashboard`
2. Server fetches your full live follower list from Instagram (paginated, 50/request)
3. Compares against the saved snapshot in Postgres
4. Saves new unfollows/follows to `change_log` table
5. Replaces the snapshot with the fresh list
6. Returns the diff to the UI

On first visit, it saves your baseline. On every subsequent visit, you see who left and who's new since last time.

---

## Limitations

- Requires a **Business or Creator** Instagram account
- Profile photos are not available via the API for other users — cards show initials avatars with a link to their profile
- Instagram limits follower fetches to 50/request — large accounts (10k+ followers) may take a few seconds to load
- Access tokens last 60 days and auto-refresh when within 10 days of expiry
