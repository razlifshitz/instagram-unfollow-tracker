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
      `https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=${user.access_token}`
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
  let url = `https://graph.instagram.com/${igUserId}/followers?fields=id,username,name&limit=50&access_token=${accessToken}`;

  while (url) {
    const res  = await fetch(url);
    const data = await res.json();
    if (data.error) throw new Error(`Instagram API: ${data.error.message}`);
    if (data.data) followers.push(...data.data);
    url = data.paging?.next || null;
  }
  return followers;
}

// ── OAuth routes ──────────────────────────────────────────────────────────────
app.get('/auth/instagram', (req, res) => {
  const params = new URLSearchParams({
    client_id:     process.env.IG_APP_ID,
    redirect_uri:  process.env.IG_REDIRECT_URI,
    scope:         'instagram_basic,instagram_manage_insights',
    response_type: 'code'
  });
  res.redirect(`https://api.instagram.com/oauth/authorize?${params}`);
});

app.get('/auth/callback', async (req, res) => {
  const { code, error } = req.query;
  if (error || !code) return res.redirect('/?error=access_denied');

  try {
    // 1. Exchange code for short-lived Instagram token
    const tokenRes = await fetch('https://api.instagram.com/oauth/access_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id:     process.env.IG_APP_ID,
        client_secret: process.env.IG_APP_SECRET,
        grant_type:    'authorization_code',
        redirect_uri:  process.env.IG_REDIRECT_URI,
        code
      })
    });
    const tokenData = await tokenRes.json();
    console.log('Short-lived token response:', JSON.stringify(tokenData).slice(0, 300));
    if (tokenData.error_type || tokenData.error) {
      throw new Error(tokenData.error_message || tokenData.error?.message || 'Token exchange failed');
    }
    const shortToken = tokenData.access_token;
    const igUserId   = tokenData.user_id;

    // 2. Exchange short-lived → long-lived token (60 days)
    const longRes = await fetch(
      `https://graph.instagram.com/access_token?grant_type=ig_exchange_token&client_id=${process.env.IG_APP_ID}&client_secret=${process.env.IG_APP_SECRET}&access_token=${shortToken}`
    );
    const longData = await longRes.json();
    console.log('Long-lived token response:', JSON.stringify(longData).slice(0, 300));
    if (longData.error) throw new Error(longData.error.message);
    const { access_token, expires_in } = longData;

    // 3. Get Instagram user info
    const meRes  = await fetch(`https://graph.instagram.com/me?fields=id,username,name&access_token=${access_token}`);
    const meData = await meRes.json();
    console.log('/me response:', JSON.stringify(meData).slice(0, 300));
    if (meData.error) throw new Error(meData.error.message);

    // 4. Upsert user in DB
    await pool.query(`
      INSERT INTO users (ig_id, username, name, access_token, token_expires_at)
      VALUES ($1,$2,$3,$4,$5)
      ON CONFLICT (ig_id) DO UPDATE SET
        username=$2, name=$3, access_token=$4, token_expires_at=$5
    `, [meData.id, meData.username, meData.name || meData.username, access_token, Date.now() + (expires_in || 5184000) * 1000]);

    req.session.userId = meData.id;
    res.redirect('/dashboard.html');
  } catch (err) {
    console.error('Auth error:', err.message);
    res.redirect('/?error=' + encodeURIComponent(err.message));
  }
});

app.get('/auth/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/'));
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
