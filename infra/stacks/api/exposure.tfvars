# Reviewed exposure record for the platform API (#182).
#
# This file is the committed, pull-request-reviewed record that the `api`
# service may be invoked publicly. Merging it changes nothing: the public
# binding is created only by the separately approved guarded apply
# (`action: apply`, stack `api`, confirmation `CHANGE-PUBLIC-ACCESS`). See
# `infra/README.md`, "How an exposure is actually applied" (#180).
#
# Comments aside it may contain only the line below; its content and location
# are pinned by `tools/infra-policy.test.mjs`. Removing the file is the same
# guarded operation in reverse.
allow_unauthenticated = true
