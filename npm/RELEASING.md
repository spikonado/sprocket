# Releasing Sprocket on npm

The npm distribution consists of `@spikonado/sprocket` plus one native package for each supported operating system and architecture.
All packages in a release must use the same version.

## First release

1. Create or confirm control of the `spikonado` organization on npm.
2. Run the **npm Release** workflow manually with a version such as `0.1.0` and leave **Publish packages to npm** disabled.
3. Download and extract the `npm-packages-0.1.0` workflow artifact when the build succeeds.
4. Sign in to npm locally with an account that has 2FA enabled. From the extracted artifact, publish the native packages interactively first and the root package last, approving each publish with 2FA:

   ```sh
   npm publish ./linux-x64-gnu
   npm publish ./linux-arm64-gnu
   npm publish ./darwin-x64
   npm publish ./darwin-arm64
   npm publish ./win32-x64-msvc
   npm publish ./sprocket
   ```

   This creates these packages:
   - `@spikonado/sprocket`
   - `@spikonado/sprocket-linux-x64-gnu`
   - `@spikonado/sprocket-linux-arm64-gnu`
   - `@spikonado/sprocket-darwin-x64`
   - `@spikonado/sprocket-darwin-arm64`
   - `@spikonado/sprocket-win32-x64-msvc`

5. In the settings for each npm package, configure a GitHub Actions trusted
   publisher with organization `spikonado`, repository `sprocket`, and workflow
   filename `npm-release.yml`. Allow `npm publish`.
6. Run the workflow manually with publishing enabled for the next release, or
   push a `vX.Y.Z` tag. Publishing authenticates through GitHub OIDC and
   includes npm provenance; no long-lived npm token is used.
7. In each package's settings, select **Require two-factor authentication and
   disallow tokens** after trusted publishing succeeds.
8. Verify the published package on each supported platform:

   ```sh
   npx @spikonado/sprocket --version
   npx @spikonado/sprocket --web
   ```

## Subsequent releases

Push a tag named `vX.Y.Z`.

Platform packages are published before the root package so users cannot install an incomplete release.
Publishing is retryable: packages whose exact version already exists are skipped.

Canary versions use the format `vX.Y.Z-canary.anything-can-go-here` and publish with the npm `canary` dist-tag.

Before tagging, a manual workflow run with publishing disabled can be used to build and inspect the complete npm package artifact.

## Development releases

After **Build and Test** succeeds for a commit on `main`, the npm workflow automatically publishes a development release as `0.3.4-dev.<full-commit-sha>` with the npm `dev` dist-tag.

Install the newest development build with:

```sh
npx @spikonado/sprocket@dev --web
```
