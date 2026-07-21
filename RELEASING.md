# Releasing

Releases are automated: pushing a `v*` tag triggers
[`.github/workflows/release.yml`](.github/workflows/release.yml), which
type-checks, tests, packages the `.vsix`, publishes it to the Visual Studio
Marketplace (and Open VSX, if configured), and creates a GitHub Release with
the `.vsix` attached.

## Versioning

The extension follows [Semantic Versioning](https://semver.org), with one
constraint imposed by the Marketplace: **it only accepts `major.minor.patch`
— semver pre-release suffixes like `1.2.0-beta.1` are not supported.**

Pre-releases therefore use the convention recommended by the VS Code team:

| Minor version | Channel | Published with |
| ------------- | ----------- | ------------------- |
| **odd** (`0.1.x`, `0.3.x`, `1.1.x`) | pre-release | `--pre-release` |
| **even** (`0.2.x`, `1.0.x`, `1.2.x`) | stable | (no flag) |

The release workflow reads the minor version and picks the channel
automatically — you never pass `--pre-release` by hand, you just choose the
right version number. VS Code installs the highest version a user is eligible
for, so stable users are not offered odd-minor builds unless they opt in to
pre-releases.

`0.1.x` is the early-preview line. **The first stable release will be `0.2.0`.**

> To opt out of the pre-release channel entirely, delete the
> "Determine release channel" step and the `${{ ... flag }}` references in the
> workflow; everything then publishes as stable.

## Cutting a release

1. Update [`CHANGELOG.md`](CHANGELOG.md): move items from `Unreleased` into a
   new `## [x.y.z]` section.
2. Bump the version (this edits `package.json`, commits, and creates the tag):
   ```bash
   npm version patch   # 0.2.0 -> 0.2.1
   npm version minor   # 0.2.1 -> 0.3.0   (note: 0.3.x is a pre-release line)
   npm version major   # 0.3.0 -> 1.0.0
   ```
3. Push the commit and the tag:
   ```bash
   git push --follow-tags
   ```
4. Watch the run under the repo's **Actions** tab. On success the extension is
   live on the Marketplace and a GitHub Release exists.

The workflow fails fast if the tag (e.g. `v0.2.0`) does not match
`package.json`'s version, so a mistyped tag never publishes.

## One-time setup: secrets

Add these under **Settings → Secrets and variables → Actions**:

- **`VSCE_PAT`** (required) — Visual Studio Marketplace token. Create it at
  <https://dev.azure.com> → User settings → Personal Access Tokens, scoped to
  **Marketplace → Manage**, for the organization that owns the `gagalo123`
  publisher.
- **`OVSX_PAT`** (optional) — [Open VSX](https://open-vsx.org) token, if you
  also want to publish there. Without it the Open VSX step is skipped (it is
  marked `continue-on-error`).

## Manual release (fallback)

If you ever need to publish outside CI:

```bash
npm ci
npx vsce package --no-dependencies -o mcap-explorer.vsix
npx vsce publish --packagePath mcap-explorer.vsix        # add --pre-release for odd minors
VSCE_PAT=... npx vsce publish --packagePath mcap-explorer.vsix
OVSX_PAT=... npx ovsx publish mcap-explorer.vsix
```
