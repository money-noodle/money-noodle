output "repository_id" {
  description = "Artifact Registry repository id."
  value       = google_artifact_registry_repository.images.repository_id
}

output "registry_host" {
  description = "Docker registry hostname for this location, for example `us-west1-docker.pkg.dev`."
  value       = "${google_artifact_registry_repository.images.location}-docker.pkg.dev"
}

output "repository_url" {
  description = "Repository path images are pushed to and referenced from, without a tag or digest."
  value       = "${google_artifact_registry_repository.images.location}-docker.pkg.dev/${google_artifact_registry_repository.images.project}/${google_artifact_registry_repository.images.repository_id}"
}
