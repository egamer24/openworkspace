-- Control-plane fixtures only. Mail content is seeded into each mailbox Durable
-- Object on mock login.
INSERT OR IGNORE INTO users (id, name, role, status, created_at, updated_at)
VALUES
  ('usr_demo_admin', 'Sam Brooks', 'admin', 'active', unixepoch() * 1000 - 864000000, unixepoch() * 1000),
  ('usr_demo_member', 'Maya Chen', 'member', 'active', unixepoch() * 1000 - 604800000, unixepoch() * 1000),
  ('usr_demo_invited', 'Alex Rivera', 'member', 'invited', unixepoch() * 1000 - 86400000, unixepoch() * 1000);

INSERT OR IGNORE INTO teams (id, name, slug, description, everyone, created_by_user_id, created_at, updated_at)
VALUES
  ('team_demo_support', 'Customer care', 'customer-care', 'Answers customer mail.', 0, 'usr_demo_admin', unixepoch() * 1000 - 691200000, unixepoch() * 1000),
  ('team_everyone', 'Everyone', 'everyone', 'Everyone active in the workspace', 1, 'usr_demo_admin', unixepoch() * 1000 - 864000000, unixepoch() * 1000);

INSERT OR IGNORE INTO team_members (team_id, user_id, can_send, created_at)
VALUES
  ('team_demo_support', 'usr_demo_admin', 1, unixepoch() * 1000 - 691200000),
  ('team_demo_support', 'usr_demo_member', 1, unixepoch() * 1000 - 604800000),
  ('team_demo_support', 'usr_demo_invited', 0, unixepoch() * 1000 - 86400000);

-- {{domain}} is the dev stack's primary mail domain (dev/stack.ts), the first in its mailDomains.
INSERT OR IGNORE INTO mailboxes (id, local_part, domain, display_name, owner_user_id, team_id, delivery, is_primary, created_by_user_id, created_at, updated_at)
VALUES
  ('mbx_demo_personal', 'sam', '{{domain}}', 'Sam Brooks', 'usr_demo_admin', NULL, 'inbox', 1, 'usr_demo_admin', unixepoch() * 1000 - 864000000, unixepoch() * 1000),
  ('mbx_demo_maya', 'maya', '{{domain}}', 'Maya Chen', 'usr_demo_member', NULL, 'inbox', 1, 'usr_demo_admin', unixepoch() * 1000 - 604800000, unixepoch() * 1000),
  ('mbx_demo_alex', 'alex', '{{domain}}', 'Alex Rivera', 'usr_demo_invited', NULL, 'inbox', 1, 'usr_demo_admin', unixepoch() * 1000 - 86400000, unixepoch() * 1000),
  ('mbx_demo_support', 'support', '{{domain}}', 'Customer care', NULL, 'team_demo_support', 'inbox', 0, 'usr_demo_admin', unixepoch() * 1000 - 691200000, unixepoch() * 1000),
  ('mbx_demo_all', 'all', '{{domain}}', 'Everyone', NULL, 'team_everyone', 'list', 0, 'usr_demo_admin', unixepoch() * 1000 - 864000000, unixepoch() * 1000);

INSERT OR IGNORE INTO access_links (
  id, kind, user_id, token_hash, created_by_user_id, expires_at, consumed_at, created_at
)
VALUES
  ('lnk_demo_alex_invite', 'invitation', 'usr_demo_invited', '9Uxgs6WM6Ia5Ml4db_j6sZGjtsDbFKQ9Jj3TO6ESrRY', 'usr_demo_admin', unixepoch() * 1000 + 604800000, NULL, unixepoch() * 1000 - 86400000),
  ('lnk_demo_maya_recovery', 'recovery', 'usr_demo_member', 'hW5ljdTB4inQJ655_9Mhv174535vPrClCAFdgi5o5V8', 'usr_demo_admin', unixepoch() * 1000 + 3600000, NULL, unixepoch() * 1000);
