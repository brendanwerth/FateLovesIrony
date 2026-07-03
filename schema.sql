-- fatelovesirony.com board schema (Cloudflare D1 / SQLite)
-- Apply with:
--   wrangler d1 execute fatelovesirony --remote --file=schema.sql

DROP TABLE IF EXISTS comments;
DROP TABLE IF EXISTS posts;

CREATE TABLE posts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL DEFAULT 'Anonymous',
  trip       TEXT,                          -- tripcode, e.g. "!aB3dE9xYz1"
  content    TEXT NOT NULL,
  ip_hash    TEXT,                          -- salted daily hash, flood control only
  created_at INTEGER NOT NULL,              -- unix ms
  bumped_at  INTEGER NOT NULL               -- unix ms, updated on reply (until bump limit)
);

CREATE INDEX idx_posts_bumped ON posts (bumped_at DESC);

CREATE TABLE comments (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id    INTEGER NOT NULL,
  name       TEXT NOT NULL DEFAULT 'Anonymous',
  trip       TEXT,
  content    TEXT NOT NULL,
  ip_hash    TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_comments_post ON comments (post_id, id);
