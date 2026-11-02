# Releasing `innstance` to npm

The package is published only by
[`.github/workflows/npm-publish.yml`](../../.github/workflows/npm-publish.yml),
using npm trusted publishing. GitHub's OIDC token is exchanged for a
single-use publish credential, and npm attaches a provenance statement
linking the tarball to this repository, the commit and the workflow run. No
npm token is stored in this repository or its secrets.

Provenance requires a public source repository. That is why the package lives
here and not in the private platform repository.

## Before this package is merged or pushed anywhere public

1. **Claim the name first.** This repository is public, and its READMEs tell
   people to run `npx innstance`. `innstance` was unclaimed on the registry
   when this package was written (and so was `innstance-setup`). Whoever
   registers it first has their code run by everyone who follows those
   instructions, with access to the home directory and its agent configs.
   So before the branch is pushed or merged, publish a placeholder `0.0.0`
   that holds only a README, by hand, from a company-owned npm account or
   organisation with two-factor authentication. Do not use a personal
   account.
2. **Decide the token model before the first real release.** The approved
   plan says new tokens are scoped and MCP tokens expire after 30 days (A2,
   then MCP OAuth in A6). This package uses the only credential the device
   flow mints today: a full-account CLI session that never expires, written
   into up to four agent configs. Once a version that writes such tokens is
   published, they cannot be taken back. Decide how npx gets a scoped,
   expiring token and how it renews one before `0.1.0` is tagged. If the
   current model ships anyway, record that decision here.
3. **The MCP endpoint must be live.** Until `/mcp` answers on the control
   plane, `npx innstance` installs only the skill. Publishing earlier is safe,
   but it is not useful.

## One-time setup (a maintainer with the npm account does this)

Until steps 1 to 5 are all done, pushing a release tag does nothing: the
publish job is skipped. Do them in this order. Turning the workflow on (step
5) comes last.

1. **Register the trusted publisher.** On npmjs.com, open the package
   settings, go to Trusted publishing, and choose GitHub Actions with:
   * organisation/user: `ImpossibleFinance`
   * repository: `impossible-hosting-cli`
   * workflow filename: `npm-publish.yml`
   * environment: `npm`
2. **Lock publishing to that path.** In the same settings, set publishing
   access to "Require two-factor authentication and disallow tokens", so the
   workflow is the only way to publish.
3. **Protect the `npm` environment. This step is required, not optional.**
   npm checks the repository, the workflow file name and the environment
   name. It does not check the branch or tag. The checks inside
   `npm-publish.yml` (tag format, commit on `main`, the
   `NPM_TRUSTED_PUBLISHING` switch) live in a file that anyone with write
   access can change on a branch of their own. A branch whose
   `npm-publish.yml` runs on push and names the `npm` environment gets an
   OIDC token that npm accepts. Only the environment's protection rules stop
   that. In Settings, then Environments, create `npm` and set:
   * **Deployment branches and tags:** "Selected branches and tags", with one
     rule, the tag pattern `npm-v*`, and no branches. A workflow run from any
     branch is then refused the environment, and with it the OIDC token npm
     would accept.
   * **Required reviewers:** at least one maintainer, with "Prevent
     self-review" on, so the person who pushed the tag cannot also approve
     the publish.
4. **Restrict who can create release tags.** Add a tag ruleset for `npm-v*`
   that lets only maintainers create, update or delete those tags. Without it,
   anyone with write access could push a matching tag. The environment rule
   in step 3 then matches it, and only the reviewer stands between that tag
   and a publish.
5. **Turn the workflow on.** Set the repository variable
   `NPM_TRUSTED_PUBLISHING` to `enabled` (Settings, then Secrets and variables,
   then Actions, then Variables).

Also make `npm-package / result` a required check on `main`. That is the only
job of that workflow that always reports. The test jobs it summarises are
skipped on changes that do not touch the package.

## Each release

1. Land the change on `main` with `version` bumped in `package.json`. The
   `npm-package` workflow must be green.
2. Tag that commit and push the tag:

   ```sh
   git tag npm-v0.1.0 <commit on main>
   git push origin npm-v0.1.0
   ```

3. A reviewer approves the `npm` environment deployment. The workflow then
   refuses to publish when:
   * the tagged commit is not on `main`;
   * the tag does not equal `npm-v` plus the `package.json` version;
   * the tests fail;
   * the pinned skill is not on the skill repository's `main`, or no longer
     matches what GitHub serves.

   Otherwise it publishes with provenance. These checks catch mistakes. The
   environment rules in step 3 of the setup are what stop a publish that did
   not come from a reviewed tag.
4. Check the release. The npm page shows the provenance badge and links to
   this repository, the commit and the run.
   `npm view innstance@<version> dist.attestations` lists the attestations.
   To verify signatures, install the version into an empty project and run
   `npm audit signatures` there.

## Moving the skill pin

The package installs one reviewed revision of the
[skill](https://github.com/ImpossibleFinance/impossible-hosting-skill). To ship
a newer one, pin a commit that is already on that repository's protected
`main`. The script refuses any other commit. Normally this is the same commit
as the Go CLI's `internal/agentskill/source.go`.

```sh
node scripts/pin-skill.js <40-character commit>
npm test
```

Commit the updated `lib/skill-pin.json` and release as above.

The skill repository's name and organisation are part of every published
version. Downloads follow a same-host redirect, so a rename or a transfer
keeps working while GitHub keeps redirecting the old path. Do not create a
new repository under the old name.
