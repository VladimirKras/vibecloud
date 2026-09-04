output "url" {
  value = "https://${yandex_api_gateway.gateway.domain}"
}

output "project_id" {
  value = local.project_id
}

output "monitoring_dashboard_url" {
  value = "https://monium.yandex.cloud/projects/folder__${local.project_id}/dashboards/${yandex_monitoring_dashboard.serverless_red.dashboard_id}"
}

output "database_connection_strings" {
  value = {
    for key, database in yandex_ydb_database_serverless.databases : key => database.ydb_full_endpoint
  }
}
