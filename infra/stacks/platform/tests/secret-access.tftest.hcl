# Who may read the declared secrets, and who may not.
#
# Synthetic desired configuration only; the bootstrap remote-state read is
# overridden and no provider is reached. Nothing here is or contains a secret
# value: this stack declares containers and their access boundary, never a version
# (ADR-0005, ADR-0012).
#
# The grant lives in this stack because setting IAM on a secret needs authority to
# mutate Secret Manager, which the federated deployer that runs a routine service
# deploy does not have. A grant declared in the release path could only fail the
# deploy that needed it (#217). Since #224 that same deployer does hold secret-level
# metadata read on each declared container — enough to refresh them in a plan, never
# enough to read a value — and this stack is where that is declared too, because an
# identity can never grant itself anything.
mock_provider "google" {}

override_data {
  target = data.terraform_remote_state.bootstrap
  values = {
    outputs = {
      contract_project_id                     = "example-project"
      contract_region                         = "us-west1"
      contract_deployer_service_account_email = "delivery-deployer@example-project.iam.gserviceaccount.com"
      contract_runtime_service_account_emails = {
        "platform-api" = "platform-api-runtime@example-project.iam.gserviceaccount.com"
        "web"          = "web-runtime@example-project.iam.gserviceaccount.com"
      }
    }
  }
}

variables {
  bootstrap_state_bucket = "example-bootstrap-state"
  project_number         = "123456789012"
  # Deliberately not billing-account-shaped: `tools/infra-policy.test.mjs` refuses a
  # committed literal that looks like a real billing account id, and this test needs
  # the variable set rather than realistic.
  billing_account_id           = "example-billing-account"
  budget_alert_email_addresses = ["alerts@example.test"]
}

run "the_projection_secret_is_readable_by_the_api_runtime_identity_alone" {
  command = plan

  # One secret, one consumer, resolved from the service name through the bootstrap
  # contract rather than from an address written down here.
  assert {
    condition = (
      length(module.secret_store.accessor_register) == 1 &&
      contains(keys(module.secret_store.accessor_register), "platform-api-projection-database-url")
    )
    error_message = "Exactly the projection connection string carries an accessor grant; found: ${join(", ", keys(module.secret_store.accessor_register))}"
  }

  assert {
    condition = (
      length(module.secret_store.accessor_register["platform-api-projection-database-url"]) == 1 &&
      contains(
        module.secret_store.accessor_register["platform-api-projection-database-url"],
        "serviceAccount:platform-api-runtime@example-project.iam.gserviceaccount.com"
      )
    )
    error_message = "The projection secret is readable by the API's own runtime identity and by nothing else."
  }

  # The web is never a database client, and the deployer manages containers rather
  # than contents. Both are rules worth failing loudly rather than reading off a
  # register.
  assert {
    condition = alltrue(flatten([
      for secret_id, members in module.secret_store.accessor_register : [
        for member in members :
        member != "serviceAccount:web-runtime@example-project.iam.gserviceaccount.com" &&
        member != "serviceAccount:delivery-deployer@example-project.iam.gserviceaccount.com"
      ]
    ]))
    error_message = "Neither the web runtime identity nor the deployer may hold secretAccessor: the first is not a database client, the second manages containers rather than contents (ADR-0005)."
  }

  # The container is still declared empty. A grant on a secret with no version is
  # deliberate and harmless: it is what lets the maintainer add the value without a
  # second apply.
  assert {
    condition     = length(module.secret_store.secret_ids) == 1
    error_message = "The store declares exactly the one projection container."
  }
}

run "a_consumer_named_by_address_rather_than_service_is_refused" {
  command = plan

  variables {
    secret_consumer_services = {
      "platform-api-projection-database-url" = [
        "platform-api-runtime@example-project.iam.gserviceaccount.com",
      ]
    }
  }

  expect_failures = [var.secret_consumer_services]
}

run "a_secret_with_no_consumer_is_refused_rather_than_silently_unreadable" {
  command = plan

  variables {
    secret_consumer_services = {
      "platform-api-projection-database-url" = []
    }
  }

  expect_failures = [var.secret_consumer_services]
}

run "the_deployer_can_plan_the_container_and_read_no_value" {
  command = plan

  # Metadata read for every declared container, for the identity that plans this
  # stack. Without it the refresh is refused and there is no plan at all (#224).
  assert {
    condition = (
      length(module.secret_store.metadata_reader_register) ==
      length(module.secret_store.secret_ids)
    )
    error_message = "Every declared container needs a plan-only reader, or the next pipeline plan of this stack is refused on the one that lacks it."
  }

  assert {
    condition = alltrue([
      for secret_id, reader in module.secret_store.metadata_reader_register :
      length(reader.members) == 1 &&
      contains(reader.members, "serviceAccount:delivery-deployer@example-project.iam.gserviceaccount.com")
    ])
    error_message = "The deployer is the only metadata reader; nothing else needs to plan this stack."
  }

  assert {
    condition = alltrue([
      for secret_id, reader in module.secret_store.metadata_reader_register :
      reader.role == "roles/secretmanager.viewer"
    ])
    error_message = "The plan-only grant is `roles/secretmanager.viewer` at secret level, which carries no versions.access."
  }

  # The runtime identities are not plan-only identities. The API reads the value
  # through its accessor grant; the web reads nothing at all, and giving it standing
  # metadata read would be the first step towards treating it as a database client.
  assert {
    condition = alltrue(flatten([
      for secret_id, reader in module.secret_store.metadata_reader_register : [
        for service, email in data.terraform_remote_state.bootstrap.outputs.contract_runtime_service_account_emails :
        !contains(reader.members, "serviceAccount:${email}")
      ]
    ]))
    error_message = "No runtime identity may hold the plan-only metadata grant: a workload either consumes a secret or has no business seeing it."
  }

  # And the separation holds in the other direction, which is the one that would
  # matter: the identity that plans must never be the identity that can read.
  assert {
    condition = alltrue([
      for secret_id, members in module.secret_store.accessor_register :
      !contains(members, "serviceAccount:delivery-deployer@example-project.iam.gserviceaccount.com")
    ])
    error_message = "The deployer must never appear as an accessor. It plans containers; it does not read contents (ADR-0005)."
  }
}
