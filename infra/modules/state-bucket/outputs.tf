output "bucket_name" {
  description = "Name of the state bucket, for use as the `bucket` argument of a `gcs` backend block."
  value       = google_storage_bucket.state.name
}

output "bucket_url" {
  description = "Fully qualified bucket URL."
  value       = google_storage_bucket.state.url
}
