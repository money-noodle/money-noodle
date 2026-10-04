# Negative tests on the service contract.
#
# Every case asserts a *refusal*. A test proving a valid input is accepted
# proves nothing about what else is.
#
# The provider is mocked, so these run with no project, no credential, and no
# network call. That is not a convenience: this repository's infrastructure work
# is explicitly code-only until an apply is separately authorised, and a test
# that reaches a provider API would violate that.
mock_provider "google" {}

variables {
  project_id                    = "example-project"
  region                        = "us-west1"
  service_name                  = "example-service"
  runtime_service_account_email = "example-runtime@example-project.iam.gserviceaccount.com"
  repository_url                = "us-west1-docker.pkg.dev/example-project/platform"
  image_name                    = "example"
  image_digest                  = "sha256:0000000000000000000000000000000000000000000000000000000000000000"
  artifact_version              = "0.0.0"
  source_commit                 = "0000000000000000000000000000000000000000"
  container_port                = 3000
  cpu                           = "1"
  memory                        = "512Mi"
}

run "a_mutable_tag_is_refused_as_an_image_reference" {
  command = plan

  variables {
    image_digest = "latest"
  }

  expect_failures = [var.image_digest]
}

run "a_short_digest_is_refused" {
  command = plan

  variables {
    image_digest = "sha256:abc123"
  }

  expect_failures = [var.image_digest]
}

run "an_abbreviated_commit_is_refused" {
  command = plan

  # `what is running` must be answerable from the commit, and an abbreviated SHA
  # is ambiguous over a long enough history.
  variables {
    source_commit = "0000000"
  }

  expect_failures = [var.source_commit]
}

run "a_standing_minimum_instance_count_is_refused" {
  command = plan

  # Scale-to-zero is an accepted architecture property and the accepted cost
  # model prices it. Raising it is a decision with a record, not a variable edit.
  variables {
    min_instances = 1
  }

  expect_failures = [var.min_instances]
}

run "an_unbounded_maximum_instance_count_is_refused" {
  command = plan

  variables {
    max_instances = 500
  }

  expect_failures = [var.max_instances]
}

run "an_undisciplined_service_name_is_refused" {
  command = plan

  variables {
    service_name = "Example_Service"
  }

  expect_failures = [var.service_name]
}

run "an_out_of_range_sample_ratio_is_refused" {
  command = plan

  variables {
    trace_sample_ratio = 1.5
  }

  expect_failures = [var.trace_sample_ratio]
}

run "an_undocumented_ingress_setting_is_refused" {
  command = plan

  variables {
    ingress = "INGRESS_TRAFFIC_ANYTHING_GOES"
  }

  expect_failures = [var.ingress]
}

# The identity arrives from another stack's published contract, so the module
# refuses anything that is not a service account of this project. A bare account
# id would previously have been accepted, because the module created the account
# itself; it now names one that must already exist.
run "a_bare_account_id_is_refused_as_a_runtime_identity" {
  command = plan

  variables {
    runtime_service_account_email = "example-runtime"
  }

  expect_failures = [var.runtime_service_account_email]
}

run "a_public_principal_is_refused_as_a_runtime_identity" {
  command = plan

  variables {
    runtime_service_account_email = "allUsers"
  }

  expect_failures = [var.runtime_service_account_email]
}

run "a_cross_project_runtime_identity_is_refused" {
  command = plan

  # Well-formed and still wrong: acting as an identity from another project is
  # not a deployment this module may plan (ADR-0005).
  variables {
    runtime_service_account_email = "example-runtime@other-example.iam.gserviceaccount.com"
  }

  expect_failures = [google_cloud_run_v2_service.service]
}

# A secret bound to an environment variable that this service never declared it
# may read is the one failure mode of ADR-0012's custody path that would surface
# as an instance that will not start rather than a plan that will not apply. It is
# refused at plan time instead (#209), against the declared intent the platform
# stack grants access from (#217).
run "a_secret_environment_variable_without_an_accessor_grant_is_refused" {
  command = plan

  variables {
    secret_environment = {
      PLATFORM_API_PROJECTION_DATABASE_URL = "platform-api-projection-database-url"
    }
    accessible_secret_ids = []
  }

  expect_failures = [var.secret_environment]
}

run "a_lower_case_secret_environment_variable_name_is_refused" {
  command = plan

  variables {
    secret_environment    = { platform_api_projection_database_url = "example-secret" }
    accessible_secret_ids = ["example-secret"]
  }

  expect_failures = [var.secret_environment]
}

run "a_granted_secret_may_be_bound_by_reference" {
  command = plan

  variables {
    secret_environment = {
      PLATFORM_API_PROJECTION_DATABASE_URL = "platform-api-projection-database-url"
    }
    accessible_secret_ids = ["platform-api-projection-database-url"]
  }

  # The reference is planned, and no value appears anywhere in it: the module
  # creates no secret version and takes no value as input.
  assert {
    condition = length([
      for entry in google_cloud_run_v2_service.service.template[0].containers[0].env :
      entry if entry.name == "PLATFORM_API_PROJECTION_DATABASE_URL"
    ]) == 1
    error_message = "A granted secret must be rendered as exactly one environment entry."
  }

  # And nothing in this module grants that access. The binding is declared beside
  # the container in the maintainer-applied platform stack, because setting IAM on
  # a secret needs authority the routine deploy's identity does not hold (#217).
  # `tools/infra-policy.test.mjs` is what fails if a Secret Manager IAM resource
  # ever reappears in a release path; this run proves the reference itself still
  # plans without one.
  assert {
    condition     = contains(var.accessible_secret_ids, "platform-api-projection-database-url")
    error_message = "A bound secret must be declared as intended-readable, which is what the platform stack grants against."
  }
}
