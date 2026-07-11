# Server Deployment Log

## v72 - 2026-07-12

- Source: `1eb8f3f` (`v72 finalize monochrome UI and task navigation`).
- Scope: deployed code and static resources only. Runtime data, uploads, composed media, environment configuration, authentication cache and logs were excluded from the sync.
- Backup and rollback: a pre-deployment runtime backup and the prior stable release are retained. Rollback restores code and static resources only; it must not restore or replace production business data.
- Result: health check passed and the online static entry reports `20260712-v72`.
- Data protection check: production accounts remain at 80. Existing assets, productions, delivery records, drafts and analytics remain available after deployment.
- Role smoke: administrator, supplier parent and supplier child login/authorization paths passed. Temporary supplier test accounts were removed after verification.
- UI smoke: homepage task details route into the relevant workspace; batch creation exposes per-account reference image controls; supplier navigation and delivery view load; voice lab exposes MiniMax voices, preview/favorite controls and default speed `1.2`.

## Operating Rules

- Deploy only tracked code and static assets from the approved release commit.
- Never sync local runtime state over production data. Preserve the server database, JSON state, uploads, composed media, environment files, credentials, authentication cache and logs.
- Record a deployment result in both this file and the corresponding version section. Log only real server incidents in `Problem Document.md`.
- Keep this log redacted: do not add server addresses, passwords, API keys, tokens or account credentials.
