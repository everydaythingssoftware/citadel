# Updater and release operations

For maintainers publishing releases and validating app updates.

## Setup (one-time)

1. Generate signing keys:

```bash
bunx tauri signer generate -w ~/.tauri/citadel.key
```

2. Set `plugins.updater.pubkey` in `src-tauri/tauri.conf.json` to the generated public key.
3. Add repo secrets:
- `TAURI_SIGNING_PRIVATE_KEY`
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`

## Release workflow

File: `.github/workflows/release.yml`

- Triggers: manual (`workflow_dispatch`) and nightly schedule.
- Release types: `patch`, `minor`, `major`, `custom`, `nightly`.
- Nightly builds are published as prereleases.
- `createUpdaterArtifacts` is enabled by the release workflow only; local builds keep it off.
- `tauri-action` publishes signed updater metadata (`latest.json`).

## Runtime behavior

- Updater runs only in production builds under Tauri (not in dev).
- Startup auto-check runs from second launch onward.
- Users can `Check for updates`.
- Users can toggle `Auto updates: On/Off`.
- Users can choose `Install and restart` when an update is available.

## Channel behavior

- Endpoint: `https://github.com/everydaythingssoftware/citadel/releases/latest/download/latest.json`
- This tracks latest non-prerelease release, so nightly prereleases are excluded.

## Quick verification

1. Release job succeeds and publishes `latest.json` artifacts.
2. First launch of a fresh install does not auto-check.
3. Second launch checks and shows notification when update exists.
4. Manual `Check for updates` and `Install and restart` work.
5. `Auto updates` toggle persists across restarts.
