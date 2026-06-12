# Publishing PercentVibed npm packages

PercentVibed publishes one CLI package, one scanner wrapper package, and the native scanner packages that have npm trusted publishing configured.

For now, CI only builds and publishes:

| Package | Purpose |
|---|---|
| `percentvibed` | Main Bun/TypeScript CLI |
| `@percentvibed/scanner` | Required scanner wrapper package |
| `@percentvibed/scanner-darwin-arm64` | macOS Apple Silicon scanner N-API addon |
| `@percentvibed/scanner-linux-x64` | Linux x64 scanner N-API addon |

Future native packages exist in the repo but are not built/published yet:

- `@percentvibed/scanner-darwin-x64`
- `@percentvibed/scanner-linux-arm64`
- `@percentvibed/scanner-win32-arm64`
- `@percentvibed/scanner-win32-x64`

Add those back to `packages/scanner/package.json` and `.github/workflows/release-npm.yml` after npm trusted publishing is configured for each package.

The CLI depends on `@percentvibed/scanner`, so the scanner is not optional at runtime for `capture` on supported platforms.

## GitHub release workflow

The release workflow is:

```txt
.github/workflows/release-npm.yml
```

It runs on semver tags with or without a `v` prefix (for example `0.1.0` or `v0.1.0`) and by manual dispatch.

It does the following on Linux:

1. installs Bun, Node, and Zig
2. typechecks the CLI
3. cross-compiles the Zig scanner for currently configured packages:
   - macOS ARM64
   - Linux x64
4. copies each `.node` addon into the matching native package
5. builds the CLI
6. runs the large PR smoke test with the built Linux x64 scanner
7. packs publishable npm packages as artifacts
8. publishes packages with npm trusted publishing / OIDC provenance

The workflow uses:

```yaml
permissions:
  contents: write
  id-token: write
```

Publishing uses:

```bash
npm publish --provenance --access public
```

## One-time npm OIDC setup

npm trusted publishing requires each package to exist before you can configure OIDC on npmjs.com. This setup is **not run in CI**. Run it once from your laptop/local terminal to create placeholder packages, then configure trusted publishing in the npm web UI.

For the currently published set, run locally:

```bash
npx setup-npm-trusted-publish percentvibed
npx setup-npm-trusted-publish @percentvibed/scanner
npx setup-npm-trusted-publish @percentvibed/scanner-darwin-arm64
npx setup-npm-trusted-publish @percentvibed/scanner-linux-x64
```

For scoped packages, the tool defaults to public access, but this is also fine:

```bash
npx setup-npm-trusted-publish @percentvibed/scanner-linux-x64 --access public
```

After each placeholder publish, visit:

```txt
https://www.npmjs.com/package/<package-name>/access
```

Configure trusted publishing for this GitHub repository and workflow:

```txt
Workflow: .github/workflows/release-npm.yml
Environment: none, unless you later add one
```

Also configure npm package MFA policy for automation/publish according to your npm organization policy.

## Adding more platforms later

For each new platform package:

1. Run `setup-npm-trusted-publish` locally for that package.
2. Configure trusted publishing on npmjs.com for `.github/workflows/release-npm.yml`.
3. Add the package to `packages/scanner/package.json` optional dependencies.
4. Add the Zig target to the workflow build step.
5. Add the package to the workflow pack and publish lists.

## Release process

1. Update package versions consistently.
2. Run local validation:

   ```bash
   bun run --cwd packages/cli typecheck
   bun run scan:build
   bun run test
   ```

3. Commit changes.
4. Tag the release:

   ```bash
   git tag 0.1.0
   git push origin 0.1.0
   ```

5. The GitHub workflow builds, packs, smoke tests, uploads tarballs, and publishes with provenance.

## Notes

- Linux performs all current cross-compilation to keep the release pipeline simple and reproducible.
- The uploaded tarballs are useful for debugging exactly what was published.
- The publish order publishes native scanner packages first, then the wrapper, then the CLI.
- If a package version already exists on npm, `npm publish` will fail. Bump versions before re-running.
