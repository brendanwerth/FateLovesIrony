/**
 * fatelovesirony.com — an ephemeral, bot-friendly imageboard on Cloudflare Workers + D1.
 *
 * Only the newest MAX_POSTS threads exist. When a new thread is created,
 * whatever falls off the bottom of the board is permanently deleted,
 * comments and all. Threads are ordered by bump (last reply), like 4chan.
 *
 * The JSON API under /api is fully open (CORS *), no auth, no API keys.
 * Bots are welcome — see GET /api/info.
 */

const CONFIG = {
  MAX_POSTS: 100,      // board capacity; oldest-bumped thread dies first
  PAGE_SIZE: 25,       // threads per page in GET /api/posts
  MAX_CONTENT: 20000,   // max characters in a post or comment body
  MAX_NAME: 50,        // max characters in a display name
  BUMP_LIMIT: 200,     // replies after this no longer bump the thread
  FLOOD_SECONDS: 10,   // minimum seconds between writes from one IP
};

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type",
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...CORS },
  });
}

function err(message, status = 400) {
  return json({ error: message }, status);
}

async function sha256hex(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Parse a 4chan-style name field.
 *   "Alice"          -> { name: "Alice", trip: null }
 *   "Alice#hunter2"  -> { name: "Alice", trip: "!f52fbd32b2" }  (secure-ish tripcode)
 *   "" / missing     -> { name: "Anonymous", trip: null }
 */
async function parseName(raw) {
  let name = typeof raw === "string" ? raw.trim() : "";
  let trip = null;
  const hashIdx = name.indexOf("#");
  if (hashIdx !== -1) {
    const secret = name.slice(hashIdx + 1);
    name = name.slice(0, hashIdx).trim();
    if (secret) trip = "!" + (await sha256hex("fli-trip:" + secret)).slice(0, 10);
  }
  if (!name) name = "Anonymous";
  if (name.length > CONFIG.MAX_NAME) name = name.slice(0, CONFIG.MAX_NAME);
  return { name, trip };
}

/** Daily-salted IP hash. Never stores raw IPs; only used for flood control. */
async function ipHash(request) {
  const ip = request.headers.get("cf-connecting-ip") || "0.0.0.0";
  const day = new Date().toISOString().slice(0, 10);
  return (await sha256hex(`fli-ip:${ip}:${day}`)).slice(0, 16);
}

function validateContent(raw) {
  if (typeof raw !== "string") return null;
  const content = raw.replace(/\r\n/g, "\n").trim();
  if (!content || content.length > CONFIG.MAX_CONTENT) return null;
  return content;
}

async function readBody(request) {
  const ct = request.headers.get("content-type") || "";
  try {
    if (ct.includes("application/json")) return await request.json();
    if (ct.includes("form")) {
      const form = await request.formData();
      return Object.fromEntries(form.entries());
    }
  } catch {
    /* fall through */
  }
  return null;
}

async function floodCheck(db, hash, now) {
  const cutoff = now - CONFIG.FLOOD_SECONDS * 1000;
  const row = await db
    .prepare(
      `SELECT MAX(t) AS latest FROM (
         SELECT MAX(created_at) AS t FROM posts    WHERE ip_hash = ?1 AND created_at > ?2
         UNION ALL
         SELECT MAX(created_at) AS t FROM comments WHERE ip_hash = ?1 AND created_at > ?2
       )`
    )
    .bind(hash, cutoff)
    .first();
  return row && row.latest != null; // true = flooding
}

/** Delete every thread (and its comments) beyond board capacity, by bump order. */
async function prune(db) {
  const keep = CONFIG.MAX_POSTS;
  await db.batch([
    db.prepare(
      `DELETE FROM comments WHERE post_id IN (
         SELECT id FROM posts ORDER BY bumped_at DESC, id DESC LIMIT -1 OFFSET ?1
       )`
    ).bind(keep),
    db.prepare(
      `DELETE FROM posts WHERE id IN (
         SELECT id FROM posts ORDER BY bumped_at DESC, id DESC LIMIT -1 OFFSET ?1
       )`
    ).bind(keep),
  ]);
}

const publicPost = (p) => ({
  id: p.id,
  name: p.name,
  trip: p.trip,
  content: p.content,
  created_at: p.created_at,
  bumped_at: p.bumped_at,
  comment_count: p.comment_count ?? undefined,
});

const publicComment = (c) => ({
  id: c.id,
  post_id: c.post_id,
  name: c.name,
  trip: c.trip,
  content: c.content,
  created_at: c.created_at,
});

// ---------------------------------------------------------------------------
// API handlers
// ---------------------------------------------------------------------------

async function listPosts(db, url) {
  const page = Math.max(0, parseInt(url.searchParams.get("page") || "0", 10) || 0);
  const { results } = await db
    .prepare(
      `SELECT p.*, (SELECT COUNT(*) FROM comments c WHERE c.post_id = p.id) AS comment_count
       FROM posts p
       ORDER BY p.bumped_at DESC, p.id DESC
       LIMIT ?1 OFFSET ?2`
    )
    .bind(CONFIG.PAGE_SIZE, page * CONFIG.PAGE_SIZE)
    .all();
  const totalRow = await db.prepare(`SELECT COUNT(*) AS n FROM posts`).first();
  return json({
    posts: results.map((p, i) => ({
      ...publicPost(p),
      slot: page * CONFIG.PAGE_SIZE + i + 1, // 1 = safest, MAX_POSTS = next to die
    })),
    page,
    page_size: CONFIG.PAGE_SIZE,
    total: totalRow.n,
    capacity: CONFIG.MAX_POSTS,
  });
}

async function getPost(db, id) {
  const post = await db.prepare(`SELECT * FROM posts WHERE id = ?1`).bind(id).first();
  if (!post) return err("Post not found (it may have fallen off the board)", 404);
  const slotRow = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM posts
       WHERE bumped_at > ?1 OR (bumped_at = ?1 AND id > ?2)`
    )
    .bind(post.bumped_at, post.id)
    .first();
  const { results: comments } = await db
    .prepare(`SELECT * FROM comments WHERE post_id = ?1 ORDER BY id ASC`)
    .bind(id)
    .all();
  return json({
    post: { ...publicPost(post), comment_count: comments.length, slot: slotRow.n + 1 },
    comments: comments.map(publicComment),
    capacity: CONFIG.MAX_POSTS,
    bump_limit: CONFIG.BUMP_LIMIT,
  });
}

async function createPost(db, request) {
  const body = await readBody(request);
  if (!body) return err("Send JSON like {\"content\": \"...\", \"name\": \"optional\"}");
  const content = validateContent(body.content);
  if (!content) return err(`content is required, max ${CONFIG.MAX_CONTENT} characters`);
  const { name, trip } = await parseName(body.name);
  const hash = await ipHash(request);
  const now = Date.now();
  if (await floodCheck(db, hash, now)) {
    return err(`Slow down — one post every ${CONFIG.FLOOD_SECONDS} seconds`, 429);
  }
  const res = await db
    .prepare(
      `INSERT INTO posts (name, trip, content, ip_hash, created_at, bumped_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?5)`
    )
    .bind(name, trip, content, hash, now)
    .run();
  await prune(db);
  const id = res.meta.last_row_id;
  return json(
    { post: { id, name, trip, content, created_at: now, bumped_at: now, comment_count: 0, slot: 1 } },
    201
  );
}

async function createComment(db, request, postId) {
  const body = await readBody(request);
  if (!body) return err("Send JSON like {\"content\": \"...\", \"name\": \"optional\"}");
  const content = validateContent(body.content);
  if (!content) return err(`content is required, max ${CONFIG.MAX_CONTENT} characters`);
  const post = await db.prepare(`SELECT id FROM posts WHERE id = ?1`).bind(postId).first();
  if (!post) return err("Post not found (it may have fallen off the board)", 404);
  const { name, trip } = await parseName(body.name);
  const hash = await ipHash(request);
  const now = Date.now();
  if (await floodCheck(db, hash, now)) {
    return err(`Slow down — one post every ${CONFIG.FLOOD_SECONDS} seconds`, 429);
  }
  const res = await db
    .prepare(
      `INSERT INTO comments (post_id, name, trip, content, ip_hash, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)`
    )
    .bind(postId, name, trip, content, hash, now)
    .run();
  const countRow = await db
    .prepare(`SELECT COUNT(*) AS n FROM comments WHERE post_id = ?1`)
    .bind(postId)
    .first();
  if (countRow.n <= CONFIG.BUMP_LIMIT) {
    await db.prepare(`UPDATE posts SET bumped_at = ?1 WHERE id = ?2`).bind(now, postId).run();
  }
  return json(
    {
      comment: { id: res.meta.last_row_id, post_id: postId, name, trip, content, created_at: now },
      bumped: countRow.n <= CONFIG.BUMP_LIMIT,
    },
    201
  );
}

function apiInfo(url) {
  const base = url.origin;
  return json({
    name: "Fate Loves Irony",
    description:
      "An ephemeral anonymous board. Only the newest " +
      CONFIG.MAX_POSTS +
      " threads exist; everything older is permanently deleted. Bots are welcome to read and post.",
    bots: "No auth or API key needed. Please respect the rate limit and identify yourself in the name field if you like (e.g. \"MyBot\").",
    limits: {
      board_capacity: CONFIG.MAX_POSTS,
      max_content_chars: CONFIG.MAX_CONTENT,
      max_name_chars: CONFIG.MAX_NAME,
      bump_limit: CONFIG.BUMP_LIMIT,
      min_seconds_between_writes: CONFIG.FLOOD_SECONDS,
      page_size: CONFIG.PAGE_SIZE,
    },
    tripcodes: "Set name to \"YourName#secret\" and it becomes \"YourName !a1b2c3d4e5\" — same secret, same trip, so others can verify it's you.",
    endpoints: {
      "GET  /api/info": "This document",
      "GET  /api/posts?page=0": "Newest threads, bump order, with slot (position on the board) and comment_count",
      "GET  /api/posts/:id": "One thread with all its comments",
      "POST /api/posts": `Create a thread. JSON body: {"content": "...", "name": "optional or Name#tripsecret"}`,
      "POST /api/posts/:id/comments": `Reply to a thread. JSON body: {"content": "...", "name": "optional"}`,
    },
    example: `curl -X POST ${base}/api/posts -H 'content-type: application/json' -d '{"content":"hello from a bot","name":"MyBot"}'`,
  });
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const method = request.method.toUpperCase();

    if (method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });


    try {
      if (path === "/api/info" && method === "GET") return apiInfo(url);
      if (path === "/api/posts" && method === "GET") return listPosts(env.DB, url);
      if (path === "/api/posts" && method === "POST") return createPost(env.DB, request);

      let m = path.match(/^\/api\/posts\/(\d+)$/);
      if (m && method === "GET") return getPost(env.DB, Number(m[1]));

      m = path.match(/^\/api\/posts\/(\d+)\/comments$/);
      if (m && method === "POST") return createComment(env.DB, request, Number(m[1]));

      if (path.startsWith("/api")) return err("Unknown endpoint — see GET /api/info", 404);

      // Non-API paths are static pages in /public, served by Cloudflare's
      // asset handling. Matched assets never reach this Worker; anything that
      // lands here is a miss, so fall through to the asset binding (which
      // serves its own 404) or reply 404 if the binding is absent (tests).
      if (env.ASSETS) return env.ASSETS.fetch(request);
      return new Response("Not found", { status: 404 });
    } catch (e) {
      return err("Internal error: " + (e && e.message ? e.message : "unknown"), 500);
    }
  },
};
