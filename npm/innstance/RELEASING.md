# Releasing `innstance` to npm

The package is published only by
[`.github/workflows/npm-publish.yml`](../../.github/workflows/npm-publish.yml),
using npm trusted publishing. GitHub's OIDC token is exchanged for a
single-use publish credential, and npm attaches a provenance statement
linking the tarball to this repository, the commit and the workflow run. No
npm token is stored in this repository or its secrets.

Provenance requires a public source repository. That is why the package lives
here and not in the private platform repository.

## One-time setup (a maintainer with the npm account does this)

Until these steps are done, pushing a release tag does nothing: the publish
job is skipped.

1. **Own the name.** `innstance` was unclaimed on the registry when this
   package was written. Publish from a company-owned npm account or
   organisation, not a personal one, and enable two-factor authentication on
   it. npm sets up trusted publishing from an existing package's settings
   page. If that page is not available for a name with no versions yet,
   reserve the name with a placeholder `0.0.0`. The placeholder holds only a
   README and is published by hand from that account.
2. **Register the trusted publisher.** On npmjs.com, open the package settings,
   go to Trusted publishing, and choose GitHub Actions with:
   * organisation/user: `ImpossibleFinance`
   * repository: `impossible-hosting-cli`
   * workflow filename: `npm-publish.yml`
   * environment: `npm`
3. **Lock publishing to that path.** In the same settings, set publishing
   access to "Require two-factor authentication and disallow tokens", so the
   workflow is the only way to publish.
4. **Guard the GitHub side.**
   * Create the `npm` environment (Settings, then Environments). Add required
     reviewers if a second person should approve each release.
   * Add a tag ruleset that lets only maintainers create `npm-v*` tags.
5. **Turn the workflow on.** Set the repository variable
   `NPM_TRUSTED_PUBLISHING` to `enabled` (Settings, then Secrets and variables,
   then Actions, then Variables).

## Each release

1. Land the change on `main` with `version` bumped in `package.json`. The
   `npm-package` workflow must be green.
2. Tag that commit and push the tag:

   ```sh
   git tag npm-v0.1.0 <commit on main>
   git push origin npm-v0.1.0
   ```

3. The workflow refuses to publish when:
   * the tagged commit is not on `main`;
   * the tag does not equal `npm-v` plus the `package.json` version;
   * the tests fail;
   * the pinned skill no longer matches GitHub.

   Otherwise it publishes with provenance.
4. Check the release: the npm page shows the provenance badge, and
   `npm audit signatures` verifies it on any machine that installs the
   package.

## Moving the skill pin

The package installs one reviewed revision of the
[skill](https://github.com/ImpossibleFinance/impossible-hosting-skill). To ship
a newer one, pin a commit that is already on that repository's protected
`main`. Normally this is the same commit as the Go CLI's
`internal/agentskill/source.go`.

```sh
node scripts/pin-skill.js <40-character commit>
npm test
```

Commit the updated `lib/skill-pin.json` and release as above.
