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
  project_id                 = "example-project"
  region                     = "us-west1"
  service_name               = "example-service"
  runtime_service_account_id = "example-runtime"
  repository_url             = "us-west1-docker.pkg.dev/example-project/platform"
  image_name                 = "example"
  image_digest               = "sha256:0000000000000000000000000000000000000000000000000000000000000000"
  artifact_version           = "0.0.0"
  source_commit              = "0000000000000000000000000000000000000000"
  container_port             = 3000
  cpu                        = "1"
  memory                     = "512Mi"
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
