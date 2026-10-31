# Releasing Kvali

One git tag publishes the same version everywhere Kvali is installed from:

| Where | Used by | How the workflow signs in |
| --- | --- | --- |
| VS Code Marketplace | VS Code | trusted publishing, no token |
| Open VSX | Antigravity, Cursor, Windsurf, VSCodium | the `OVSX_PAT` repository secret |
| npm (`@kvali/cli`) | `npx @kvali/cli` | trusted publishing, no token |
| GitHub release | people who install the `.vsix` by hand | the workflow's own token |
| Claude Code plugin | `/plugin install kvali --marketplace webGrandpa/kvali` | nothing to publish: the repository is the marketplace (`.claude-plugin/marketplace.json`) |

Each target is a separate job in [`.github/workflows/release.yml`](.github/workflows/release.yml): one that is not set up yet only warns, the others still publish.

## One-time setup

1. **Repository** public (Settings → General → Change visibility).
2. **VS Code Marketplace**: at https://marketplace.visualstudio.com/manage create the publisher with only Name and ID `webgrandpa` (extra fields can trip a false "suspicious content" check). Under **Trusted Publishing** add a policy: owner `webGrandpa`, repository `kvali`, workflow `release.yml`, no environment.
3. **Open VSX**: an Eclipse account (https://accounts.eclipse.org/user/register) whose **GitHub Username** field is `webGrandpa`, the same GitHub account you sign in to Open VSX with. Sign in at https://open-vsx.org with GitHub, then avatar → Settings → **Log in with Eclipse** → **Show Publisher Agreement** → Agree. Settings → **Access Tokens** → new token, saved as the repository secret `OVSX_PAT` (Settings → Secrets and variables → Actions). The first release creates the `webgrandpa` namespace.

   Later, optional: claim the namespace with an issue at https://github.com/EclipseFdn/open-vsx.org/issues/new/choose, so Open VSX shows the extension as verified. An owned namespace with a published extension can also use trusted publishing (Settings → Trusted Publishers, then `ovsx publish --trusted-publishing` with `id-token: write`) and drop the token.
4. **npm**: the CLI is `@kvali/cli` (npm refuses the plain name `kvali` as too close to an existing package). An account at https://www.npmjs.com with two-factor authentication, and the free organization `kvali` (avatar → **Add Organization** → `kvali` → unlimited public packages, free), so the `@kvali` scope belongs to the project. npm sets a trusted publisher only on a package that exists, and a trusted publisher that has not published within 48 hours of being added expires. So reserve the name with an empty placeholder, add the trusted publisher, and push the first release tag within 48 hours: the workflow then publishes the real version, with provenance.

   ```bash
   mkdir -p /tmp/kvali && cd /tmp/kvali
   npm init -y > /dev/null && npm pkg set name=@kvali/cli version=0.0.0 license=MIT description="Kvali CLI placeholder: releases are published from GitHub Actions"
   npm login
   npm publish --access public
   ```

   Then on npmjs.com: package `@kvali/cli` → Settings → **Trusted Publisher** → GitHub Actions: `webGrandpa` / `kvali` / `release.yml`, no environment. After the first release: `npm deprecate @kvali/cli@0.0.0 "Placeholder; use the latest version"`.

## Every release

```bash
node scripts/set-version.mjs 0.6.1      # every package.json and the CLI's --version
# add a CHANGELOG.md entry, then:
git commit -am "Kvali 0.6.1" && git push
git tag v0.6.1 && git push origin v0.6.1
```

Watch it under Actions → Release. Running the workflow by hand (Run workflow) builds and tests without publishing.
