# Who may read the declared secrets, and who may not.
#
# Synthetic desired configuration only; the bootstrap remote-state read is
# overridden and no provider is reached. Nothing here is or contains a secret
# value: this stack declares containers and their access boundary, never a version
# (ADR-0005, ADR-0012).
#
# The grant lives in this stack because setting IAM on a secret needs Secret
# Manager authority, and the federated deployer that runs a routine service deploy
# holds no Secret Manager role at all. A grant declared in the release path could
# only fail the deploy that needed it (#217).
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
