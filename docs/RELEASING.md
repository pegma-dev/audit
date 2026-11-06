# Release operations

`@pegma/audit` publishes only from a stable GitHub release. Merging a pull
request never publishes, and the workflow has no manual-dispatch or npm-token
fallback.

## Required external configuration

Before the first release through this workflow:

- configure `@pegma/audit` on npm with the GitHub Actions trusted publisher
  `pegma-dev/audit`, workflow `publish.yml`, environment `npm-publish`, and
  allowed action `npm publish`;
- create the GitHub `npm-publish` environment. A second reviewer is not
  required under Pegma's single-maintainer policy;
- create the repository Actions variable `RELEASE_ALLOWED_SIGNERS` containing
  the reviewed Git SSH allowed-signers entry for the maintainer's release key;
  this is public-key material, not a secret; and
- create an active tag ruleset targeting `v*` that prevents tag updates and
  deletions and limits tag creation to the release maintainer.

Do not add `NODE_AUTH_TOKEN`, an npm automation token, or another credential
fallback. After one trusted-publisher release is verified, disable any
remaining traditional npm publish tokens.

## Release procedure

The version in `packages/audit/package.json` is the release version. Change it
through an ordinary reviewed pull request and run the complete gate on Node 22
and 24.

After that pull request is merged, create a signed annotated tag at the exact
`origin/main` commit, push the tag, verify the fetched tag, and only then
create the GitHub release with `--verify-tag`. Do not let GitHub create the tag
and never move or recreate a release tag.

The release workflow verifies that the tag:

- is a stable annotated `vX.Y.Z` tag signed by an allowed signer;
- matches the package version;
- points to the GitHub release-event commit; and
- is contained in `origin/main`.

The preparation job authenticates the tag in a temporary bare repository
before checkout or dependency installation. It then checks out the immutable
release-event commit without retained credentials, installs dependencies with
the pinned pnpm, installs the reviewed npm bytes, runs the full gate, and
builds and packs once. The packed manifest is checked against the reviewed
source manifest, and the output is sealed as exactly one manifest and one
tarball before upload. A separate job downloads that sealed artifact and
imports it from a clean consumer without OIDC permission.

Only the `npm-publish` job receives `id-token: write`. It performs no checkout,
installs no project dependencies, and does not download pnpm. It authenticates
the tag again in a fresh bare repository, installs the reviewed npm bytes,
downloads the prepared artifact by its upload id, and verifies the preparation
manifest digest, exact two-file inventory, release commit, and tarball SHA-256
and SHA-512. Registry lookup and publication run from a fresh empty directory
with empty npm configuration files and a minimal environment.

## Safe retry

The workflow is globally serialized. Re-run the failed release jobs against
the unchanged tag:

- an absent version is published;
- an existing version with identical `dist.integrity` is verified and skipped;
- a different integrity, or any registry error other than `E404`, stops the
  release.

Never unpublish and reuse a version. If any released byte must change, prepare
a new version and a new signed tag.
