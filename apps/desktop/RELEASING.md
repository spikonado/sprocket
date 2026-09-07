# Releasing the Sprocket desktop app

GitHub Releases at `spikonado/sprocket` are the desktop update feed.
`electron-builder` 26 writes `app-update.yml` into each packaged app with that GitHub provider.
Installed copies then fetch channel files (`latest.yml` / `canary.yml` and the platform suffixes) through `electron-updater` 6.

Keep this packaging config on electron-builder 26 keys.
`zip.writeUpdateInfo`, grouped `nativeModules`, and `electronGet` are not part of the 26.15 schema this repo uses.

## Channels

Push a tag.

| Tag                                  | GitHub release            | Channel files                                                                |
| ------------------------------------ | ------------------------- | ---------------------------------------------------------------------------- |
| `vX.Y.Z`                             | Latest (not a prerelease) | `latest.yml`, `latest-mac.yml`, `latest-linux.yml`, `latest-linux-arm64.yml` |
| `vX.Y.Z-canary.anything-can-go-here` | Prerelease                | `canary.yml`, `canary-mac.yml`, `canary-linux.yml`, `canary-linux-arm64.yml` |

GitHub publishing does not infer the channel from the version on its own.
The workflow writes `build.publish.channel` before `electron-builder` runs.

Stable installs query `/releases/latest` and the `latest*` files.
Canary installs (`*-canary.*`) set `allowPrerelease` and look for `canary*` files on the newest matching prerelease tag.

`app-update.yml` does not contain `autoDownload` or `autoInstallOnAppQuit`.
Those stay false in the packaged main process so a found update never downloads or installs until the UI asks.

## Artifacts

Each matrix leg builds with `--publish never`, then the publish job copies installers, zips, blockmaps, and yml into one directory.

macOS ships both `dmg` (installer) and `zip` (Squirrel.Mac / `electron-updater`).
The zip blockmap is required for differential downloads.

`latest-mac.yml` / `canary-mac.yml` are the only names both Mac arches write.
The publish job merges only the `files` list so both `x64` and `arm64` zips stay listed.
Fields such as `releaseNotes`, `stagingPercentage`, and `isAdminRightsRequired` are kept when they match, or filled in from the arch that set them.
A colliding installer, a different `version`, or a metadata entry with the same URL and a different checksum fails the job instead of keeping whichever arch finished last.
The merge script refuses to write into a nonempty `--output` directory and will not delete that path.

The publish job runs `bun install --frozen-lockfile` so the merge script can import `js-yaml`.
Linux already uses `*-linux.yml` vs `*-linux-arm64.yml`, so those do not merge.

## Signing and notarization

macOS signing is optional in this workflow.
GitHub-hosted Macs have unrelated identities, so `CSC_IDENTITY_AUTO_DISCOVERY` stays `false` until `CSC_LINK` is set.

Set these repository secrets when you want signed, notarized Mac builds.

| Secret             | Use                                                                                                                |
| ------------------ | ------------------------------------------------------------------------------------------------------------------ |
| `CSC_LINK`         | Base64-encoded Developer ID Application `.p12`, used only on macOS jobs                                            |
| `CSC_KEY_PASSWORD` | Password for that `.p12`                                                                                           |
| `APPLE_API_KEY`    | App Store Connect API `.p8` as PEM or base64. Written to a temp file because `@electron/notarize` 2.5 wants a path |
| `APPLE_API_KEY_ID` | Key ID                                                                                                             |
| `APPLE_API_ISSUER` | Issuer UUID                                                                                                        |

Apple ID notarization is the fallback if the API key is unset. Set `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, and `APPLE_TEAM_ID` together.
Do not set `APPLE_TEAM_ID` when using API key credentials. `@electron/notarize` rejects that mix.

Windows signing uses `WIN_CSC_LINK` and `WIN_CSC_KEY_PASSWORD` on the Windows job only.
`forceCodeSigning` stays false so a missing cert still produces installers.

### Unsigned builds

Without those secrets, CI still publishes installers.

macOS Gatekeeper blocks first launch until the user opens the app from Finder.
In-app Mac updates need a signed build. Leave `CSC_LINK` unset only when you are publishing installers that people will open from Finder, not update in place.
Notarization does not run, so later macOS versions keep the unidentified-developer warning.

Windows SmartScreen warns on the unsigned NSIS installer.
`electron-updater` skips publisher checks when `app-update.yml` has no `publisherName`, which unsigned Windows builds will not have.

Linux AppImage updates do not need a signature for the GitHub provider.

## Local package

```sh
bun run build:release
```

Artifacts land in `apps/desktop/dist/` as `sprocket-desktop-*`.
That command does not publish. Channel files appear locally when `build.publish` is present, which it is.
