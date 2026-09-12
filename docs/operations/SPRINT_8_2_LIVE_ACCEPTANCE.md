# Sprint 8.2 live acceptance

Status: in progress; publication, independent owner decision and rollback are not yet accepted.

## Deployment fixes

- The migrator now sets `search_path` on every connection. Otherwise a real 0012 → 0013
  upgrade creates unqualified functions in `public`, although a fresh installation passes.
- Migration transaction stripping now handles leading SQL comments; the migration body and
  registry insertion stay within the migrator's transaction. Released SQL files are unchanged.
- The Neon helper installs 0012, closes that connection, upgrades with the real migrator and
  checks all three capability functions belong to `navocms`. A repeated run applies nothing.
- The browser client uses its own exact token audience; MCP retains its resource audience.
  Signed-token regressions reject substitution in both directions. Browser HTTP/visual tests
  use a separate verifier that cannot authorize browser tokens on MCP.

## Staging preparation

- Compared deployment against current main before updating.
- Registered a confidential WorkOS client with the exact staging callback URL and PKCE.
  Stored and delivered its four settings in the existing encrypted dotenvx file; preserved
  existing deployed role permissions. No plaintext credentials were written or committed.
- Applied unchanged migration 0013 and its checksum in one transaction after checking all
  twelve existing registry rows. Verified all three capability functions are in `navocms`.

## Verification notes

The initial upgrade gate passed, with all 51 PostgreSQL integration tests green. One unrelated
process-timeout fixture failed because Node was killed before writing its PID marker. The fixture
now writes the PID using a shell builtin before `exec sleep`; it still asserts the timed-out
process is dead and no artifact is registered. The final gate is rerun after this correction.
