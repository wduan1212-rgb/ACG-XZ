# Server Deployment Log

## v88 - 2026-07-16

- Source: `f44d770` (`v88 align batch references and copy regeneration`), cumulatively including v86-v88. The online entry reports `20260716-v88-1`.
- Scope: deployed exactly 34 modified tracked application code and static files from a clean worktree after checksum validation, complete staging tests and a file-only dry-run. No file deletion or directory metadata synchronization was used. Production database/runtime state, uploads, composed media, accounts, members, assets, deliveries, drafts, analytics, environment configuration, authentication cache and logs were excluded.
- Backup and rollback: retained rollback point `v88-pre-20260716-164948`, containing the pre-deployment code snapshot, a consistent SQLite backup, upload/composed checkpoints, private environment backup and collection baseline. Rollback restores code/static resources only and must not replace current production business data.
- Result: clean local, server staging and production environments all passed the complete test suite 43/43, all JavaScript syntax checks and Python compilation passed, the private environment fingerprint stayed unchanged, service restart and health checks passed, and recent service logs contained no error or traceback.
- v87 browser smoke: administrator login loaded 80 accounts with no console error or warning. The BGM library showed two legacy account-bound assets as a flat shared library without an account filter; the editing-material library also used the shared view. No production asset was created, renamed, downloaded or deleted during validation.
- v88 browser smoke: the batch workspace loaded the production task board, 50 image accounts, unified reference and per-account custom reference areas. Existing sessions and drafts remained readable. Explicit-reference/type-switch/title-regeneration behavior is covered by the production 43/43 regression suite; no live generation or task mutation was used for smoke testing.
- Provider smoke: LLM, image, TTS, Seedance and digital-human configuration endpoints all reported configured and reachable. No private provider value was changed.
- Data protection check: no protected collection or file count decreased. Accounts 80, members 12, analytics links 45, productions 465, jobs 679, batches 64, metric snapshots 108, sessions 56, voice presets 5, supplier bindings 52 and composed media 147 were preserved. Active users added one asset and one upload while validation was running; these valid production writes were retained.

## v85 - 2026-07-16

- Source: `5f7a9ec` (`v85 stabilize audio mix and subtitle recognition`). The online main JavaScript and stylesheet entries report `20260716-v85-1`.
- Scope: deployed exactly 9 changed application code and static files from a clean commit archive after a dry-run. No delete-style synchronization was used. The production database, runtime state, uploads, composed media, accounts, members, assets, deliveries, drafts, analytics, environment configuration, authentication cache and logs were excluded.
- Backup and rollback: retained rollback point `v85-pre-20260716-120840`, containing the pre-deployment code snapshot, a consistent SQLite backup and upload/composed checkpoints. Rollback must restore code/static resources only and must not replace current production business data.
- Result: the production virtual environment passed the complete test suite 35/35, all JavaScript syntax checks and Python compilation passed, the private environment fingerprint stayed unchanged, service restart and health checks passed, and post-restart service logs contained no error or traceback.
- Audio/subtitle validation: a disposable real FFmpeg test preserved the digital-human clip voice, mixed a looping BGM, skipped duplicate external narration and produced a valid AAC audio stream. Information-flow subtitle quality guards, hallucination cleanup, recognition deduplication and manual-track protection passed the production test suite.
- Browser smoke: administrator login loaded 80 accounts with no console error or warning. Account performance opened a per-content detail with title, platform, playback, likes, favorites, comments, shares and the publication link. The data assistant returned a plain-text answer without Markdown formatting.
- Provider smoke: LLM, image, video/digital-human and TTS configuration endpoints all reported configured and reachable. No private provider value was changed.
- Data protection check: no protected collection or file count decreased. Accounts 80, members 12, assets 2524, productions 452, jobs 676, batches 62, metric snapshots 108, sessions 55, voice presets 4, supplier bindings 52, uploads 2313 and composed media 142 were preserved. While validation was running, active users added 2 analytics links and 4 supplier download activities; these valid concurrent production writes were retained instead of being overwritten from the backup.

## v84 - 2026-07-16

- Source: `7756a08` (`v84 unify dashboard and editing workflows`). The online entry reports `20260715-v84-5`.
- Scope: deployed exactly 29 changed application code and static files from a clean commit after a dry-run. No delete-style synchronization was used. The production database, runtime state, uploads, composed media, accounts, members, assets, deliveries, drafts, analytics, environment configuration, authentication cache and logs were excluded.
- Backup and rollback: retained rollback point `v84-pre-20260716-011950`, containing the pre-deployment code snapshot, a consistent SQLite backup and runtime media checkpoints. Rollback must restore code/static resources only and must not replace current production business data.
- Result: the production virtual environment passed the complete test suite 31/31, all JavaScript syntax checks and Python compilation passed, the private environment fingerprint stayed unchanged, service restart succeeded, and the health endpoint remained available.
- Server dependency: the host initially had no CJK font file. Standard Noto CJK fonts were installed and the application font selector then returned a valid family and directory; a real one-second Chinese SRT burn-in with FFmpeg produced a valid video.
- Provider config smoke: LLM, image, video, digital-human and TTS configuration endpoints all reported configured and reachable. No private provider value was changed.
- Data protection check: pre/post counts were identical: accounts 80, members 12, assets 2523, productions 453, jobs 676, batches 62, analytics links 23, metric snapshots 108, sessions 55, voice presets 4, supplier bindings 52, supplier activity 28, uploads 2312 and composed media 140.
- Browser smoke: administrator login loaded the composite dashboard with 80 accounts and no console errors. The merged assets/drafts route opened on the draft panel and showed 53 existing drafts; no archive, delete or generation action was performed.
- Validation note: a first temporary test directory contained only the 29-file delta, so unchanged imports were absent and the test process stopped before production synchronization. Rebuilding the temporary directory from the complete current application plus the delta passed 31/31; production was not changed by the incomplete-stage attempt.

## v83 - 2026-07-15

- Source: `9c9f594` (`v83 stabilize creative and editing workflows`). The online entry reports `20260715-v83-2`.
- Scope: deployed exactly 28 changed application code and static files from a clean commit archive after an rsync dry-run. No delete-style synchronization was used. The production database, runtime JSON/state, uploads, composed media, accounts, members, assets, deliveries, drafts, analytics, environment configuration, authentication cache and logs were excluded.
- Backup and rollback: retained rollback point `v83-pre-20260715-174905`, containing the pre-deployment code/config snapshot, a consistent SQLite backup and runtime media checkpoints. Rollback must restore code/static resources only and must not replace current production business data.
- Result: the server virtual environment passed the complete test suite 23/23, all deployed JavaScript syntax checks and Python compilation passed, the environment fingerprint stayed unchanged, service restart succeeded, and the health endpoint remained available.
- Data protection check: pre/post counts were identical: accounts 80, members 12, assets 2488, productions 452, jobs 676, analytics links 23, metric snapshots 108, sessions 55, batches 61, voice presets 4, supplier bindings 52, supplier activity 28, uploads 2296 and composed media 138.
- Browser smoke: administrator login loaded the production state and reported 80 accounts with no console errors. The creator settings member list omitted supplier-child accounts, the restored supplier parent remained present, and analytics displayed separate `account / published title` columns with the account filter available.
- Incident log: the first post-sync test command used the system Python and stopped before service restart because project dependencies were unavailable there. The validation was rerun with the project virtual environment and passed 23/23; no service outage or business-data write occurred, so no additional product incident was added to `Problem Document.md`.

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
