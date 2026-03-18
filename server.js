require('dotenv').config();
const express = require('express');
const session = require('express-session');
const { Pool }  = require('pg');
const path = require('path');

const app = express();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.static(__dirname));
app.use(session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 7 * 24 * 60 * 60 * 1000, secure: process.env.NODE_ENV === 'production' }
}));

// ── Database setup ────────────────────────────────────────────────────────────
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      ig_id            TEXT PRIMARY KEY,
      username         TEXT,
      name             TEXT,
      access_token     TEXT,
      token_expires_at BIGINT,
      last_checked_at  TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS follower_snapshots (
      user_ig_id       TEXT    NOT NULL,
      follower_ig_id   TEXT    NOT NULL,
      follower_username TEXT,
      follower_name    TEXT,
      PRIMARY KEY (user_ig_id, follower_ig_id)
    );

    CREATE TABLE IF NOT EXISTS change_log (
      id               SERIAL PRIMARY KEY,
      user_ig_id       TEXT NOT NULL,
      follower_ig_id   TEXT,
      follower_username TEXT,
      follower_name    TEXT,
      change_type      TEXT NOT NULL,
      detected_at      TIMESTAMP DEFAULT NOW()
    );
  `);
  console.log('Database ready');
}

// ── Auth helpers ──────────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  next();
}

async function refreshTokenIfNeeded(user) {
  const tenDays = 10 * 24 * 60 * 60 * 1000;
  if (user.token_expires_at - Date.now() < tenDays) {
    const r = await fetch(
      `https://graph.facebook.com/oauth/access_token?grant_type=fb_exchange_token&client_id=${process.env.IG_APP_ID}&client_secret=${process.env.IG_APP_SECRET}&fb_exchange_token=${user.access_token}`
    );
    const data = await r.json();
    if (data.access_token) {
      await pool.query(
        'UPDATE users SET access_token=$1, token_expires_at=$2 WHERE ig_id=$3',
        [data.access_token, Date.now() + (data.expires_in || 5184000) * 1000, user.ig_id]
      );
      return data.access_token;
    }
  }
  return user.access_token;
}

// ── Instagram API helpers ─────────────────────────────────────────────────────
async function fetchAllFollowers(igUserId, accessToken) {
  const followers = [];
  let url = `https://graph.facebook.com/v19.0/${igUserId}/followers?fields=id,username,name&limit=50&access_token=${accessToken}`;

  while (url) {
    const res  = await fetch(url);
    const data = await res.json();
    if (data.error) throw new Error(`Instagram API: ${data.error.message}`);
    if (data.data) followers.push(...data.data);
    url = data.paging?.next || null;
  }
  return followers;
}

// ── resolveIgAccount: try multiple endpoints to find IG account ───────────────
async function resolveIgAccount(accessToken) {
  const base = 'https://graph.facebook.com/v19.0';
  const igFields = 'instagram_business_account{id,username,name}';

  // Helper: extract first IG account from a pages-style response
  function extractFromPages(data) {
    const page = data?.data?.find(p => p.instagram_business_account?.id);
    return page ? page.instagram_business_account : null;
  }

  // 1. Standard Facebook Login: /me/accounts
  try {
    const r = await fetch(`${base}/me/accounts?fields=id,name,${igFields}&access_token=${accessToken}`);
    const d = await r.json();
    console.log('/me/accounts response:', JSON.stringify(d).slice(0, 300));
    if (!d.error) {
      const ig = extractFromPages(d);
      if (ig?.id) { console.log('Found IG via /me/accounts'); return ig; }
    }
  } catch (e) { console.warn('/me/accounts failed:', e.message); }

  // 2. Facebook Login for Business: /me/assigned_pages
  try {
    const r = await fetch(`${base}/me/assigned_pages?fields=id,name,${igFields}&access_token=${accessToken}`);
    const d = await r.json();
    console.log('/me/assigned_pages response:', JSON.stringify(d).slice(0, 300));
    if (!d.error) {
      const ig = extractFromPages(d);
      if (ig?.id) { console.log('Found IG via /me/assigned_pages'); return ig; }
    }
  } catch (e) { console.warn('/me/assigned_pages failed:', e.message); }

  // 3. /me/client_pages
  try {
    const r = await fetch(`${base}/me/client_pages?fields=id,name,${igFields}&access_token=${accessToken}`);
    const d = await r.json();
    console.log('/me/client_pages response:', JSON.stringify(d).slice(0, 300));
    if (!d.error) {
      const ig = extractFromPages(d);
      if (ig?.id) { console.log('Found IG via /me/client_pages'); return ig; }
    }
  } catch (e) { console.warn('/me/client_pages failed:', e.message); }

  // 4a. Get FB user ID then try /{fb_user_id}/instagram_business_accounts
  let fbUserId = null;
  try {
    const r = await fetch(`${base}/me?fields=id&access_token=${accessToken}`);
    const d = await r.json();
    if (d.id) { fbUserId = d.id; console.log('FB user ID:', fbUserId); }
  } catch (e) { console.warn('/me failed:', e.message); }

  if (fbUserId) {
    try {
      const r = await fetch(`${base}/${fbUserId}/instagram_business_accounts?fields=id,username,name&access_token=${accessToken}`);
      const d = await r.json();
      console.log(`/${fbUserId}/instagram_business_accounts response:`, JSON.stringify(d).slice(0, 300));
      if (!d.error && d.data?.[0]?.id) {
        console.log('Found IG via instagram_business_accounts');
        return d.data[0];
      }
    } catch (e) { console.warn('instagram_business_accounts failed:', e.message); }
  }

  // 4b. /me/instagram_accounts (personal IG accounts)
  try {
    const r = await fetch(`${base}/me/instagram_accounts?fields=id,username,name&access_token=${accessToken}`);
    const d = await r.json();
    console.log('/me/instagram_accounts response:', JSON.stringify(d).slice(0, 300));
    if (!d.error && d.data?.[0]?.id) {
      console.log('Found IG via /me/instagram_accounts');
      return d.data[0];
    }
  } catch (e) { console.warn('/me/instagram_accounts failed:', e.message); }

  // 4c. Hardcoded fallback: try the well-known IG account ID for this user
  const HARDCODED_IG_ID = process.env.IG_ACCOUNT_ID;
  if (HARDCODED_IG_ID) {
    try {
      const r = await fetch(`${base}/${HARDCODED_IG_ID}?fields=id,username,name&access_token=${accessToken}`);
      const d = await r.json();
      console.log(`Hardcoded IG account ${HARDCODED_IG_ID} response:`, JSON.stringify(d).slice(0, 300));
      if (!d.error && d.id) {
        console.log('Found IG via hardcoded IG_ACCOUNT_ID');
        return { id: d.id, username: d.username, name: d.name };
      }
    } catch (e) { console.warn('Hardcoded IG lookup failed:', e.message); }
  }

  return null;
}

// ── OAuth routes ──────────────────────────────────────────────────────────────
app.get('/auth/instagram', (req, res) => {
  const params = new URLSearchParams({
    client_id:     process.env.IG_APP_ID,
    redirect_uri:  process.env.IG_REDIRECT_URI,
    scope:         'instagram_basic,pages_show_list,pages_read_engagement',
    response_type: 'code'
  });
  res.redirect(`https://www.facebook.com/dialog/oauth?${params}`);
});

app.get('/auth/callback', async (req, res) => {
  const { code, error } = req.query;
  if (error || !code) return res.redirect('/?error=access_denied');

  try {
    // 1. Exchange code for short-lived FB user token
    const tokenRes = await fetch('https://graph.facebook.com/v19.0/oauth/access_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id:     process.env.IG_APP_ID,
        client_secret: process.env.IG_APP_SECRET,
        redirect_uri:  process.env.IG_REDIRECT_URI,
        code
      })
    });
    const tokenData = await tokenRes.json();
    if (tokenData.error) throw new Error(tokenData.error.message);
    const shortToken = tokenData.access_token;

    // 2. Exchange short-lived → long-lived FB user token (60 days)
    const longRes = await fetch(
      `https://graph.facebook.com/v19.0/oauth/access_token?grant_type=fb_exchange_token&client_id=${process.env.IG_APP_ID}&client_secret=${process.env.IG_APP_SECRET}&fb_exchange_token=${shortToken}`
    );
    const longData = await longRes.json();
    if (longData.error) throw new Error(longData.error.message);
    const { access_token, expires_in } = longData;

    // 3. Find linked Instagram Business/Creator account — try multiple endpoints
    const igAccount = await resolveIgAccount(access_token);
    if (!igAccount) {
      throw new Error('No Instagram Business or Creator account found. Make sure your Instagram account is connected to a Facebook Page you manage.');
    }

    // 4. Upsert user in DB
    await pool.query(`
      INSERT INTO users (ig_id, username, name, access_token, token_expires_at)
      VALUES ($1,$2,$3,$4,$5)
      ON CONFLICT (ig_id) DO UPDATE SET
        username=$2, name=$3, access_token=$4, token_expires_at=$5
    `, [igAccount.id, igAccount.username, igAccount.name || igAccount.username, access_token, Date.now() + (expires_in || 5184000) * 1000]);

    req.session.userId = igAccount.id;
    res.redirect('/dashboard.html');
  } catch (err) {
    console.error('Auth error:', err.message);
    res.redirect('/?error=' + encodeURIComponent(err.message));
  }
});

app.get('/auth/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/'));
});

// ── Manual token setup (for Graph API Explorer tokens) ────────────────────────
app.get('/auth/setup', async (req, res) => {
  const { token } = req.query;
  if (!token) {
    return res.status(400).send('Missing ?token= parameter. Get a token from developers.facebook.com/tools/explorer with instagram_basic and pages_show_list permissions.');
  }

  try {
    const igAccount = await resolveIgAccount(token);
    if (!igAccount) {
      return res.status(400).send('Could not find an Instagram account linked to this token. Make sure the token has instagram_basic and pages_show_list permissions and your Instagram is linked to a Facebook Page.');
    }

    // Upsert user in DB
    await pool.query(`
      INSERT INTO users (ig_id, username, name, access_token, token_expires_at)
      VALUES ($1,$2,$3,$4,$5)
      ON CONFLICT (ig_id) DO UPDATE SET
        username=$2, name=$3, access_token=$4, token_expires_at=$5
    `, [igAccount.id, igAccount.username, igAccount.name || igAccount.username, token, Date.now() + 5184000 * 1000]);

    req.session.userId = igAccount.id;
    res.redirect('/dashboard.html');
  } catch (err) {
    console.error('Manual setup error:', err.message);
    res.status(500).send('Setup failed: ' + err.message);
  }
});

// ── API: current user info ────────────────────────────────────────────────────
app.get('/api/me', requireAuth, async (req, res) => {
  const { rows: [user] } = await pool.query(
    'SELECT ig_id, username, name, last_checked_at FROM users WHERE ig_id=$1',
    [req.session.userId]
  );
  res.json(user);
});

// ── API: dashboard refresh ────────────────────────────────────────────────────
app.get('/api/dashboard', requireAuth, async (req, res) => {
  const userId = req.session.userId;

  try {
    // Load user
    const { rows: [user] } = await pool.query('SELECT * FROM users WHERE ig_id=$1', [userId]);
    const accessToken = await refreshTokenIfNeeded(user);

    // Load previous snapshot
    const { rows: prevSnapshot } = await pool.query(
      'SELECT follower_ig_id, follower_username, follower_name FROM follower_snapshots WHERE user_ig_id=$1',
      [userId]
    );
    const isFirstCheck = prevSnapshot.length === 0 && !user.last_checked_at;

    // Fetch live followers from Instagram
    const liveFollowers = await fetchAllFollowers(userId, accessToken);
    const liveMap = new Map(liveFollowers.map(f => [f.id, f]));
    const prevMap = new Map(prevSnapshot.map(f => [f.follower_ig_id, f]));

    // Compute diff
    const unfollowed = prevSnapshot
      .filter(f => !liveMap.has(f.follower_ig_id))
      .map(f => ({ id: f.follower_ig_id, username: f.follower_username, name: f.follower_name }));

    const newFollowers = liveFollowers
      .filter(f => !prevMap.has(f.id))
      .map(f => ({ id: f.id, username: f.username, name: f.name || f.username }));

    // Write change log (skip first check — no baseline to diff from)
    if (!isFirstCheck) {
      for (const f of unfollowed) {
        await pool.query(
          'INSERT INTO change_log (user_ig_id,follower_ig_id,follower_username,follower_name,change_type) VALUES ($1,$2,$3,$4,$5)',
          [userId, f.id, f.username, f.name, 'unfollow']
        );
      }
      for (const f of newFollowers) {
        await pool.query(
          'INSERT INTO change_log (user_ig_id,follower_ig_id,follower_username,follower_name,change_type) VALUES ($1,$2,$3,$4,$5)',
          [userId, f.id, f.username, f.name, 'follow']
        );
      }
    }

    // Replace snapshot with live data
    await pool.query('DELETE FROM follower_snapshots WHERE user_ig_id=$1', [userId]);
    for (let i = 0; i < liveFollowers.length; i += 100) {
      const batch  = liveFollowers.slice(i, i + 100);
      const values = batch.map((_, j) => `($1,$${j*3+2},$${j*3+3},$${j*3+4})`).join(',');
      const params = [userId, ...batch.flatMap(f => [f.id, f.username || '', f.name || ''])];
      await pool.query(
        `INSERT INTO follower_snapshots (user_ig_id,follower_ig_id,follower_username,follower_name) VALUES ${values}`,
        params
      );
    }

    // Update last checked timestamp
    await pool.query('UPDATE users SET last_checked_at=NOW() WHERE ig_id=$1', [userId]);

    res.json({
      user:         { username: user.username, name: user.name },
      total:        liveFollowers.length,
      prevTotal:    prevSnapshot.length,
      unfollowed,
      newFollowers,
      isFirstCheck,
      checkedAt:    new Date().toISOString()
    });
  } catch (err) {
    console.error('Dashboard error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── API: full change history ──────────────────────────────────────────────────
app.get('/api/history', requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT follower_ig_id, follower_username, follower_name, change_type, detected_at
     FROM change_log WHERE user_ig_id=$1 ORDER BY detected_at DESC LIMIT 200`,
    [req.session.userId]
  );
  res.json(rows);
});

// ── Start ─────────────────────────────────────────────────────────────────────
initDB().then(() => {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`Listening on http://localhost:${PORT}`));
}).catch(err => {
  console.error('Failed to init DB:', err);
  process.exit(1);
});
