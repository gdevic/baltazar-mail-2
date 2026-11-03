#!/usr/bin/env bash
# Release preconditions, run first by .github/workflows/release.yml. Inputs come from the
# environment: TAG (v1.2.3), EVENT (push or workflow_dispatch), REF (the ref the run started from)
# and GITHUB_SHA (the commit to build). Writes tag= and version= to GITHUB_OUTPUT.
set -euo pipefail
fail() { echo "::error::$1"; exit 1; }

tag="$TAG"
[[ "$tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail "Tag must look like v1.2.3"
version=$(tr -d '[:space:]' < VERSION)
[ "$tag" = "v$version" ] || fail "Tag $tag does not match version $version in VERSION"
if [ "$EVENT" = "workflow_dispatch" ] && [ "$REF" != "refs/heads/main" ]; then
  fail "Run releases from main, not $REF"
fi
if at=$(git rev-parse -q --verify "refs/tags/$tag^{commit}"); then
  [ "$at" = "$GITHUB_SHA" ] || fail "Tag $tag already points at $at, not at $GITHUB_SHA"
fi
echo "tag=$tag" >> "$GITHUB_OUTPUT"
echo "version=$version" >> "$GITHUB_OUTPUT"
