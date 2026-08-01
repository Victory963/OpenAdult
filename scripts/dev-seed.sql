-- Minimal development seed data for OpenAdult.
-- Usage (against a local MySQL/MariaDB):
--   mysql -h127.0.0.1 -P3307 -uroot openadult < scripts/dev-seed.sql
-- Safe to re-run: clears the seeded rows first.

SET FOREIGN_KEY_CHECKS = 0;
DELETE FROM video_actresses;
DELETE FROM videos;
DELETE FROM actresses;
DELETE FROM ads;
SET FOREIGN_KEY_CHECKS = 1;

INSERT INTO actresses (id, name, japaneseName, chineseName, bio, profileImageUrl, tags, videoCount) VALUES
  (1, 'Aki Sasaki', '佐々木あき', '佐佐木明', 'Sample actress for local dev.', 'https://picsum.photos/seed/aki/300/400', '["mature","elegant"]', 2),
  (2, 'Yua Mikami', '三上悠亜', '三上悠亚', 'Sample actress for local dev.', 'https://picsum.photos/seed/yua/300/400', '["idol","popular"]', 1);

INSERT INTO videos (id, title, description, duration, thumbnailUrl, videoUrl, category, tags, views, rating) VALUES
  (1, 'Sample Video One',   'Local dev sample video.', 1800, 'https://picsum.photos/seed/v1/640/360', 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8', 'drama',    '["drama","story"]',   1234, 4.50),
  (2, 'Sample Video Two',   'Local dev sample video.', 2400, 'https://picsum.photos/seed/v2/640/360', 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8', 'romance',  '["romance"]',          567, 4.20),
  (3, 'Sample Video Three', 'Local dev sample video.', 1200, 'https://picsum.photos/seed/v3/640/360', 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8', 'drama',    '["drama","short"]',     89, 3.90);

INSERT INTO video_actresses (videoId, actressId) VALUES
  (1, 1), (2, 1), (3, 2);

INSERT INTO ads (id, name, type, videoUrl, thumbnailUrl, clickUrl, duration, priority, isActive) VALUES
  (1, 'Sample Pre-roll', 'pre-roll', 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8', 'https://picsum.photos/seed/ad1/640/360', 'https://example.com', 15, 10, 1);
