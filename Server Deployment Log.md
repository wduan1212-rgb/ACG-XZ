# Server Deployment Log

## v82.3 - 2026-07-15

- Source: `1a82804` (`v82.3 fix shared remote state and link replacement`). The online entry reports `20260715-v82-5`.
- Scope: deployed tracked code and static resources from a clean target archive with explicit runtime exclusions and without delete-style synchronization. The production database, JSON/runtime state, uploads, composed media, accounts, members, assets, deliveries, remarks, drafts, analytics, environment configuration and authentication cache were preserved.
- Backup and rollback: retained rollback point `v82.3-pre-20260715-133201`, containing the pre-deployment code/config snapshot, a consistent SQLite backup and runtime media checkpoints. Rollback must restore code/static resources only and must not replace current production business data.
- Result: the complete server test suite passed 16/16, tracked JavaScript syntax checks and Python compilation passed, service restart succeeded, and the health endpoint remained available.
- Data protection check: pre/post counts were identical: accounts 80, members 10, assets 2377, productions 426, jobs 670, analytics links 22, metric snapshots 108, sessions 52, uploads 2188 and composed media 109.
- Role smoke: supplier-parent and assigned supplier-child logins both issued `GET /api/state`; the parent saw both isolated deliveries while the child saw only the assigned delivery. Administrator link forgery and child updates to an unassigned delivery were denied. Supplier-only download-state semantics remained intact.
- Link replacement smoke: the modify dialog selected the full current URL, multi-URL input resolved to the last newly pasted URL, and the new URL became the single current link in the supplier row, creator snapshot and analytics link. The page updated locally without horizontal overflow, console errors or warnings.
- Incident log: the ESM singleton and prefilled-link risks were already recorded in `Problem Document.md`; no additional production incident was introduced by this deployment.

## v77 - 2026-07-14

- Source: `90295f1` (`v77 polish voice preview actions and transitions`), including the cumulative v73-v77 code and static assets. The online entry reports `20260714-v77-1`.
- Scope: deployed tracked code and static resources from a clean worktree. The production environment files, database/JSON state, uploads, composed media, accounts, members, assets, delivery records, drafts, analytics, voice data, authentication cache and logs were excluded from the sync.
- Backup and rollback: retained rollback point `pre-v77-20260714-110406`, containing the pre-deployment code snapshot, a consistent SQLite backup and runtime file checkpoints. Rollback restores code/static resources only and must not replace current production business data.
- Result: service restart and health check passed. Python compilation and tracked JavaScript syntax checks passed before restart; the deployed private environment fingerprint remained unchanged.
- Data protection check: accounts 80, members 8, analytics links 21, metric snapshots 108, sessions 51 and voice presets 4 were unchanged. No key collection decreased. Assets, jobs, productions and uploads increased slightly while members were actively using the platform during validation; these were live production writes, not local-state replacement.
- Model smoke: LLM and MiniMax TTS minimum calls passed. Image generation passed both routes with real outputs: no reference image used text-to-image and a valid reference image used image-to-image. Video, digital-human and analytics providers reported configured and reachable; no private provider configuration was changed.
- Role smoke: administrator completed a real browser smoke test. Supplier-parent visibility was validated against a read-only production database copy; because production currently has no supplier-child member, the child binding and visibility path was exercised only in that disposable copy. Both supplier projections reported zero private-asset leakage and created no production test accounts or state changes.
- UI smoke: cold start, login, homepage, batch board and analytics loaded without white screen. Voice synthesis produced a playable preview at default speed `1.2`; download/delete were present, the two archive actions aligned on one row, and synthesis/design/management panel switching produced no console errors.
- Incident log: no new production incident was found, so `Problem Document.md` was not changed.

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
