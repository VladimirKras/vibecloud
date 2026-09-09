terraform {
  required_version = ">= 1.6.3, < 2.0.0"

  required_providers {
    yandex = {
      source  = "yandex-cloud/yandex"
      version = "0.218.0"
    }
    archive = {
      source  = "hashicorp/archive"
      version = "2.7.1"
    }
  }
}

provider "yandex" {}

locals {
  project_id      = var.folder_id
  runtime_id      = yandex_iam_service_account.runtime.id
  logs_enabled    = try(var.observability.logs.enabled, false)
  metrics_enabled = try(var.observability.metrics.enabled, false)
  traces_enabled  = try(var.observability.traces.enabled, false)
  telemetry       = local.logs_enabled || local.metrics_enabled || local.traces_enabled
  secret_enabled  = var.secrets != null || local.telemetry
  has_functions   = length(var.functions) > 0
  websocket_enabled = anytrue([
    for route in var.gateway.routes : upper(coalesce(route.method, "ANY")) == "WS"
  ])
  responses_enabled        = var.deployment_plan.ai.responses
  speechkit_stt_enabled    = var.deployment_plan.ai.speechkit_stt
  speechkit_tts_enabled    = var.deployment_plan.ai.speechkit_tts
  image_generation_enabled = var.deployment_plan.ai.image_generation
  artifacts                = coalesce(var.artifact_directory, "${path.module}/../dist")
  cloud_suffix             = substr(replace(local.project_id, "-", ""), 0, 8)
  runtime_name             = length("${var.name}-runtime") <= 63 ? "${var.name}-runtime" : "${trimsuffix(substr(var.name, 0, 54), "-")}-${substr(sha256("${var.name}-runtime"), 0, 8)}"
  secret_name              = length("${var.name}-secrets") <= 63 ? "${var.name}-secrets" : "${trimsuffix(substr(var.name, 0, 54), "-")}-${substr(sha256("${var.name}-secrets"), 0, 8)}"
  database_names = {
    for key in keys(var.databases) : key => length("${var.name}-${key}") <= 63 ? "${var.name}-${key}" : "${trimsuffix(substr("${var.name}-${key}", 0, 54), "-")}-${substr(sha256("${var.name}-${key}"), 0, 8)}"
  }
  function_group_keys = var.deployment_plan.function_group_keys
  function_groups     = var.deployment_plan.function_groups

  function_names = {
    for key in keys(local.function_groups) : key => length("${var.name}-${key}") <= 63 ? "${var.name}-${key}" : "${trimsuffix(substr("${var.name}-${key}", 0, 54), "-")}-${substr(sha256("${var.name}-${key}"), 0, 8)}"
  }
  asset_bucket_names = {
    for key, asset in var.assets : key => coalesce(asset.cloud_name, length("${var.name}-${key}-assets-${local.cloud_suffix}") <= 63 ? "${var.name}-${key}-assets-${local.cloud_suffix}" : "${trimsuffix(substr("${var.name}-${key}-assets", 0, 45), "-")}-${substr(sha256("${var.name}-${key}-assets"), 0, 8)}-${local.cloud_suffix}")
  }
  bucket_names = {
    for key, bucket in var.buckets : key => coalesce(bucket.cloud_name, length("${var.name}-${key}-${local.cloud_suffix}") <= 63 ? "${var.name}-${key}-${local.cloud_suffix}" : "${trimsuffix(substr("${var.name}-${key}", 0, 45), "-")}-${substr(sha256("${var.name}-${key}"), 0, 8)}-${local.cloud_suffix}")
  }
  telemetry_cluster = coalesce(
    try(var.observability.traces.cluster, null),
    try(var.observability.metrics.cluster, null),
    try(var.observability.logs.cluster, null),
    "default",
  )

  runtime_roles = toset(concat(
    local.has_functions && local.responses_enabled ? ["ai.languageModels.user", "ai.assistants.editor"] : [],
    local.has_functions && (var.deployment_plan.ai.realtime || local.image_generation_enabled) ? ["ai.models.user"] : [],
    local.has_functions && local.speechkit_stt_enabled ? ["ai.speechkit-stt.user"] : [],
    local.has_functions && local.speechkit_tts_enabled ? ["ai.speechkit-tts.user"] : [],
    local.has_functions && local.secret_enabled ? ["lockbox.payloadViewer"] : [],
    local.has_functions && length(var.databases) > 0 ? ["ydb.editor"] : [],
    local.has_functions && length(var.buckets) > 0 ? ["storage.editor"] : [],
    length(var.assets) > 0 ? ["storage.viewer"] : [],
    local.has_functions && length(local.triggers) > 0 ? ["yds.admin"] : [],
    local.has_functions && local.dlq_enabled ? ["ymq.writer"] : [],
    local.has_functions && local.websocket_enabled ? ["api-gateway.websocketWriter"] : [],
    local.has_functions && local.logs_enabled ? ["monium.logs.writer"] : [],
    local.has_functions && local.metrics_enabled ? ["monium.metrics.writer"] : [],
    local.has_functions && local.traces_enabled ? ["monium.traces.writer"] : [],
  ))

  streams = merge([for database_key, database in var.databases : {
    for stream_key, stream in database.streams : "${database_key}.${stream_key}" => {
      database_key = database_key
      stream_key   = stream_key
    }
  }]...)

  triggers = merge([for function_key, function in var.functions : {
    for trigger in function.triggers : "${function_key}/${trigger.stream}" => merge(trigger, {
      function_key = function_key
    })
  }]...)

  dlq_enabled = anytrue([
    for trigger in values(local.triggers) : trigger.dead_letter_queue != null
  ])

  crons = {
    for function_key, function in var.functions : function_key => function.cron
    if function.cron != null
  }

  release_prefix = var.release_id != null ? "_vibecloud/releases/${var.release_id}/" : ""
  release_tag    = coalesce(var.release_id, "unpublished")

  asset_files = merge(var.retained_assets, merge([for asset_key, asset in var.assets : {
    for file in fileset("${local.artifacts}/assets/${asset_key}", "**") : "${asset_key}/${local.release_prefix}${var.release_id != null ? "${asset_key}/" : ""}${file}" => {
      asset_key    = asset_key
      file         = "${local.release_prefix}${var.release_id != null ? "${asset_key}/" : ""}${file}"
      source       = "${local.artifacts}/assets/${asset_key}/${file}"
      source_hash  = filemd5("${local.artifacts}/assets/${asset_key}/${file}")
      content_type = null
    }
  }]...))

  asset_prefixes = { for key in keys(var.assets) : key => var.release_id != null ? "${local.release_prefix}${key}/" : "" }

  database_environment = {
    for key, database in yandex_ydb_database_serverless.databases :
    "${upper(replace(key, "-", "_"))}_ENDPOINT" => database.ydb_full_endpoint
  }
  bucket_environment = {
    for key, bucket in yandex_storage_bucket.buckets :
    "${upper(replace(key, "-", "_"))}_BUCKET" => bucket.bucket
  }
  stream_environment = merge([for key, stream in yandex_ydb_topic.streams : {
    "${upper(replace(replace(key, "-", "_"), ".", "_"))}_NAME"     = stream.name
    "${upper(replace(replace(key, "-", "_"), ".", "_"))}_DATABASE" = yandex_ydb_database_serverless.databases[local.streams[key].database_key].database_path
  }]...)

  gateway_routes = var.deployment_plan.gateway_routes

  # Preserve the actual prefixes of retained objects across logical asset renames.
  asset_release_prefixes = distinct([for object in values(local.asset_files) : {
    asset_key = object.asset_key
    prefix    = regex("^_vibecloud/releases/[^/]+/[^/]+/", object.file)
  } if startswith(object.file, "_vibecloud/releases/")])
  asset_release_routes = distinct(flatten([for release in local.asset_release_prefixes : [
    for route in local.gateway_routes : {
      asset_key = release.asset_key
      prefix    = release.prefix
      # Wildcard asset routes mount the entire asset set; exact routes expose one file.
      file = endswith(route.pattern, "*") ? "{path}" : (route.pattern == "/" ? "index.html" : trimprefix(route.pattern, "/"))
    } if route.assets == release.asset_key
  ]]))

  route_operations = concat(
    [for route in local.asset_release_routes : {
      path = "/${route.prefix}${route.file == "{path}" ? "{path+}" : route.file}"
      operations = { for method in ["get", "head"] : method => {
        responses  = { "200" = { description = "Immutable release asset" } }
        parameters = [for parameter in(route.file == "{path}" ? ["path"] : []) : { name = parameter, in = "path", required = true, schema = { type = "string" } }]
        x-yc-apigateway-integration = {
          type               = "object_storage"
          bucket             = yandex_storage_bucket.assets[route.asset_key].bucket
          object             = "${route.prefix}${route.file}"
          service_account_id = local.runtime_id
        }
      } }
    }],
    [for key, object in var.retained_assets : {
      path = "/${object.file}"
      operations = { for method in ["get", "head"] : method => {
        responses = { "200" = { description = "Previous release asset" } }
        x-yc-apigateway-integration = {
          type               = "object_storage"
          bucket             = yandex_storage_bucket.assets[object.asset_key].bucket
          object             = object.file
          service_account_id = local.runtime_id
        }
      } }
      } if !startswith(object.file, "_vibecloud/releases/") && !endswith(object.file, ".html") && anytrue([
        for route in local.gateway_routes : route.assets == object.asset_key && (endswith(route.pattern, "*") || trimprefix(route.pattern, "/") == object.file)
    ])],
    [for index, route in local.gateway_routes : {
      path = upper(coalesce(route.method, "ANY")) == "WS" ? route.pattern : endswith(route.pattern, "*") ? "${trimsuffix(route.pattern, "*")}{path+}" : route.pattern
      operations = merge(
        { for event in ["connect", "message", "disconnect"] :
          "x-yc-apigateway-websocket-${event}" => {
            x-yc-apigateway-integration = {
              type                   = "cloud_functions"
              tag                    = local.release_tag
              function_id            = yandex_function.functions[local.function_group_keys[route.function]].id
              service_account_id     = local.runtime_id
              payload_format_version = "1.0"
            }
          }
        if upper(coalesce(route.method, "ANY")) == "WS" },
        { for operation in ["http"] :
          (route.assets != null ? "get" : route.method == null || upper(route.method) == "ANY" ? "x-yc-apigateway-any-method" : lower(route.method)) => merge(
            {
              operationId = "route_${index}"
              responses   = { "200" = { description = "Vibecloud route" } }
              x-yc-apigateway-integration = merge(
                { service_account_id = local.runtime_id },
                route.function != null ? {
                  type                   = "cloud_functions"
                  tag                    = local.release_tag
                  function_id            = yandex_function.functions[local.function_group_keys[route.function]].id
                  payload_format_version = "1.0"
                } : {},
                route.assets != null ? {
                  type   = "object_storage"
                  bucket = yandex_storage_bucket.assets[route.assets].bucket
                  object = "${local.asset_prefixes[route.assets]}${endswith(route.pattern, "*") ? "{path}" : (trimprefix(route.pattern, "/") != "" ? trimprefix(route.pattern, "/") : "index.html")}"
                } : {},
                { for fallback in [try(var.assets[route.assets].fallback, null)] :
                  "error_object" => "${local.asset_prefixes[route.assets]}${fallback}" if route.assets != null && fallback != null
                },
              )
            },
            endswith(route.pattern, "*") ? {
              parameters = [{
                name     = "path"
                in       = "path"
                required = true
                schema   = { type = "string" }
              }]
            } : {},
          )
        if upper(coalesce(route.method, "ANY")) != "WS" },
      )
    }],
    flatten([for index, route in local.gateway_routes :
      route.assets != null ? [{
        path = endswith(route.pattern, "*") ? "${trimsuffix(route.pattern, "*")}{path+}" : route.pattern
        operations = {
          head = merge(
            {
              operationId = "route_${index}_head"
              responses   = { "200" = { description = "Vibecloud asset headers" } }
              x-yc-apigateway-integration = merge({
                type               = "object_storage"
                bucket             = yandex_storage_bucket.assets[route.assets].bucket
                object             = "${local.asset_prefixes[route.assets]}${endswith(route.pattern, "*") ? "{path}" : (trimprefix(route.pattern, "/") != "" ? trimprefix(route.pattern, "/") : "index.html")}"
                service_account_id = local.runtime_id
                },
                { for fallback in [try(var.assets[route.assets].fallback, null)] :
                  "error_object" => "${local.asset_prefixes[route.assets]}${fallback}" if fallback != null
                },
              )
            },
            endswith(route.pattern, "*") ? {
              parameters = [{
                name     = "path"
                in       = "path"
                required = true
                schema   = { type = "string" }
              }]
            } : {},
          )
        }
      }] : []
    ]),
    flatten([for index, route in local.gateway_routes :
      route.assets != null && route.pattern == "/*" ? [{
        path = "/"
        operations = {
          get = {
            operationId = "route_${index}_root"
            responses   = { "200" = { description = "Vibecloud root asset" } }
            x-yc-apigateway-integration = merge({
              type               = "object_storage"
              bucket             = yandex_storage_bucket.assets[route.assets].bucket
              object             = "${local.asset_prefixes[route.assets]}index.html"
              service_account_id = local.runtime_id
              },
              { for fallback in [try(var.assets[route.assets].fallback, null)] :
                "error_object" => "${local.asset_prefixes[route.assets]}${fallback}" if fallback != null
              },
            )
          }
          head = {
            operationId = "route_${index}_root_head"
            responses   = { "200" = { description = "Vibecloud root asset headers" } }
            x-yc-apigateway-integration = merge({
              type               = "object_storage"
              bucket             = yandex_storage_bucket.assets[route.assets].bucket
              object             = "${local.asset_prefixes[route.assets]}index.html"
              service_account_id = local.runtime_id
              },
              { for fallback in [try(var.assets[route.assets].fallback, null)] :
                "error_object" => "${local.asset_prefixes[route.assets]}${fallback}" if fallback != null
              },
            )
          }
        }
      }] : []
    ]),
  )

  route_paths = {
    for path in distinct([for route in local.route_operations : route.path]) :
    path => merge([for route in local.route_operations : route.operations if route.path == path]...)
  }
}

resource "yandex_iam_service_account" "runtime" {
  folder_id   = local.project_id
  name        = local.runtime_name
  description = "Runtime identity for ${var.name}"
}

resource "yandex_iam_service_account_iam_member" "deployer_use" {
  service_account_id = local.runtime_id
  role               = "iam.serviceAccounts.user"
  member             = var.deployer_subject
}

resource "yandex_resourcemanager_folder_iam_member" "runtime" {
  for_each  = local.runtime_roles
  folder_id = local.project_id
  role      = each.key
  member    = "serviceAccount:${local.runtime_id}"
}

resource "yandex_ydb_database_serverless" "databases" {
  for_each            = var.databases
  folder_id           = local.project_id
  name                = local.database_names[each.key]
  deletion_protection = false
}

resource "yandex_ydb_topic" "streams" {
  for_each          = local.streams
  database_endpoint = yandex_ydb_database_serverless.databases[each.value.database_key].ydb_full_endpoint
  name              = "streams/${each.value.stream_key}"
  supported_codecs  = ["raw", "gzip", "zstd"]
}

resource "yandex_storage_bucket" "assets" {
  for_each      = var.assets
  folder_id     = local.project_id
  bucket        = local.asset_bucket_names[each.key]
  force_destroy = true

  lifecycle {
    ignore_changes = [bucket]
  }
}

resource "yandex_storage_object" "assets" {
  for_each    = local.asset_files
  bucket      = yandex_storage_bucket.assets[each.value.asset_key].bucket
  key         = each.value.file
  source      = each.value.source
  source_hash = each.value.source_hash
  content_type = coalesce(each.value.content_type, lookup({
    css         = "text/css; charset=utf-8", html = "text/html; charset=utf-8",
    ico         = "image/x-icon", js = "text/javascript; charset=utf-8",
    json        = "application/json; charset=utf-8", png = "image/png",
    svg         = "image/svg+xml", txt = "text/plain; charset=utf-8",
    webmanifest = "application/manifest+json", woff2 = "font/woff2",
  }, trimprefix(try(regex("\\.[^.]+$", each.value.file), ""), "."), "application/octet-stream"))
  lifecycle {
    # Keys are immutable. Retained objects need no source files on this checkout.
    ignore_changes = [source, source_hash]
  }
}

resource "yandex_storage_bucket" "buckets" {
  for_each      = var.buckets
  folder_id     = local.project_id
  bucket        = local.bucket_names[each.key]
  force_destroy = true

  anonymous_access_flags {
    read        = each.value.public
    list        = false
    config_read = false
  }

  lifecycle {
    ignore_changes = [bucket]
  }
}

resource "yandex_lockbox_secret" "application" {
  count       = local.secret_enabled ? 1 : 0
  folder_id   = local.project_id
  name        = local.secret_name
  description = "Managed secrets for ${var.name}"
}

resource "yandex_lockbox_secret_version" "application" {
  for_each  = var.secrets != null ? var.secrets.entries : {}
  secret_id = yandex_lockbox_secret.application[0].id

  entries {
    key = each.key
    command {
      path = "node"
      args = ["-e", "process.stdout.write(require('node:crypto').randomBytes(48).toString('base64url'))"]
    }
  }
}

resource "yandex_iam_service_account_api_key" "telemetry" {
  count              = local.telemetry ? 1 : 0
  service_account_id = local.runtime_id
  description        = "Scoped Monium telemetry writer for ${var.name}"
  scopes = concat(
    local.logs_enabled ? ["yc.monium.logs.write"] : [],
    local.metrics_enabled ? ["yc.monium.metrics.write"] : [],
    local.traces_enabled ? ["yc.monium.traces.write"] : [],
  )
  output_to_lockbox {
    secret_id            = yandex_lockbox_secret.application[0].id
    entry_for_secret_key = "MONIUM_API_KEY"
  }
  depends_on = [yandex_resourcemanager_folder_iam_member.runtime, yandex_iam_service_account_iam_member.deployer_use]
}

data "archive_file" "functions" {
  for_each    = local.function_groups
  type        = "zip"
  source_dir  = "${local.artifacts}/functions/${each.key}"
  output_path = "${path.module}/.packages/${each.key}.zip"
}

resource "yandex_function" "functions" {
  for_each           = local.function_groups
  folder_id          = local.project_id
  name               = local.function_names[each.key]
  runtime            = each.value.runtime
  entrypoint         = each.value.handler
  memory             = each.value.memory_mb
  execution_timeout  = tostring(each.value.timeout_seconds)
  service_account_id = local.runtime_id
  tags               = [local.release_tag]
  user_hash          = data.archive_file.functions[each.key].output_base64sha256
  environment = merge(
    { for key, value in var.vars : key => tostring(value) },
    {
      YANDEX_AI_BASE_URL     = "https://ai.api.cloud.yandex.net/v1"
      YANDEX_AI_REALTIME_URL = "wss://ai.api.cloud.yandex.net/v1/realtime"
      YANDEX_CLOUD_FOLDER_ID = local.project_id
    },
    length(var.databases) > 0 ? { YDB_METADATA_CREDENTIALS = "1" } : {},
    local.database_environment,
    local.bucket_environment,
    local.stream_environment,
    try(var.observability.source_maps, false) && startswith(each.value.runtime, "nodejs") ? { NODE_OPTIONS = "--enable-source-maps" } : {},
    local.telemetry ? {
      MONIUM_PROJECT = "folder__${local.project_id}"
      MONIUM_CLUSTER = local.telemetry_cluster
      MONIUM_SERVICE = each.key
    } : {},
    local.metrics_enabled ? {
      MONIUM_METRICS_ENABLED       = "1"
      MONIUM_OTLP_METRICS_ENDPOINT = "https://ingest.monium.yandex.cloud/otlp/v1/metrics"
    } : {},
    local.logs_enabled ? {
      MONIUM_LOGS_ENABLED       = "1"
      MONIUM_LOG_LEVEL          = coalesce(var.observability.logs.min_level, "INFO")
      MONIUM_OTLP_LOGS_ENDPOINT = "https://ingest.monium.yandex.cloud/otlp/v1/logs"
    } : {},
    local.traces_enabled ? {
      MONIUM_TRACES_ENABLED       = "1"
      MONIUM_OTLP_TRACES_ENDPOINT = "https://ingest.monium.yandex.cloud/otlp/v1/traces"
      MONIUM_TRACE_SAMPLE_RATE    = tostring(var.observability.traces.sample_rate)
    } : {},
  )

  dynamic "secrets" {
    for_each = var.secrets != null ? var.secrets.entries : {}
    content {
      environment_variable = secrets.key
      id                   = yandex_lockbox_secret.application[0].id
      version_id           = yandex_lockbox_secret_version.application[secrets.key].id
      key                  = secrets.key
    }
  }

  dynamic "secrets" {
    for_each = local.telemetry ? toset(["MONIUM_API_KEY"]) : toset([])
    content {
      environment_variable = "MONIUM_API_KEY"
      id                   = yandex_lockbox_secret.application[0].id
      version_id           = yandex_iam_service_account_api_key.telemetry[0].output_to_lockbox_version_id
      key                  = "MONIUM_API_KEY"
    }
  }

  dynamic "log_options" {
    for_each = try(var.observability.platform_logs, null) != null ? [var.observability.platform_logs] : []
    content {
      disabled  = !log_options.value.enabled
      folder_id = log_options.value.enabled ? local.project_id : null
      min_level = log_options.value.enabled ? coalesce(log_options.value.min_level, "INFO") : null
    }
  }

  content {
    zip_filename = data.archive_file.functions[each.key].output_path
  }
  depends_on = [yandex_resourcemanager_folder_iam_member.runtime, yandex_iam_service_account_iam_member.deployer_use, terraform_data.legacy_pin, terraform_data.migrations]
}

resource "yandex_function_iam_binding" "invoker" {
  for_each    = local.function_groups
  function_id = yandex_function.functions[each.key].id
  role        = "functions.functionInvoker"
  members     = ["serviceAccount:${local.runtime_id}"]
}

resource "yandex_function_trigger" "triggers" {
  for_each  = local.triggers
  folder_id = local.project_id
  name      = length("${var.name}-${each.value.function_key}-${substr(sha256(each.key), 0, 8)}") <= 63 ? "${var.name}-${each.value.function_key}-${substr(sha256(each.key), 0, 8)}" : "${trimsuffix(substr("${var.name}-${each.value.function_key}", 0, 54), "-")}-${substr(sha256(each.key), 0, 8)}"

  function {
    tag                = local.release_tag
    id                 = yandex_function.functions[local.function_group_keys[each.value.function_key]].id
    service_account_id = local.runtime_id
    retry_attempts     = tostring(each.value.retry_attempts)
    retry_interval     = tostring(each.value.retry_interval_seconds)
  }
  data_streams {
    stream_name        = yandex_ydb_topic.streams[each.value.stream].name
    database           = yandex_ydb_database_serverless.databases[local.streams[each.value.stream].database_key].database_path
    service_account_id = local.runtime_id
    batch_cutoff       = tostring(each.value.batch_cutoff_seconds)
    batch_size         = tostring(each.value.batch_size_bytes)
  }
  dynamic "dlq" {
    for_each = each.value.dead_letter_queue != null ? [each.value.dead_letter_queue] : []
    content {
      queue_id           = dlq.value
      service_account_id = local.runtime_id
    }
  }
  depends_on = [yandex_resourcemanager_folder_iam_member.runtime, yandex_iam_service_account_iam_member.deployer_use, yandex_function_iam_binding.invoker, yandex_storage_object.assets]
}

resource "yandex_function_trigger" "crons" {
  for_each  = local.crons
  folder_id = local.project_id
  name      = length("${var.name}-${each.key}-cron") <= 63 ? "${var.name}-${each.key}-cron" : "${trimsuffix(substr("${var.name}-${each.key}", 0, 49), "-")}-${substr(sha256(each.key), 0, 8)}-cron"

  function {
    tag                = local.release_tag
    id                 = yandex_function.functions[local.function_group_keys[each.key]].id
    service_account_id = local.runtime_id
    retry_attempts     = "1"
    retry_interval     = "10"
  }
  timer {
    cron_expression = each.value.expression
    payload         = var.deployment_plan.timer_payloads[each.key]
  }
  depends_on = [yandex_resourcemanager_folder_iam_member.runtime, yandex_iam_service_account_iam_member.deployer_use, yandex_function_iam_binding.invoker, yandex_storage_object.assets]
}

resource "yandex_api_gateway" "gateway" {
  folder_id = local.project_id
  name      = var.name
  spec = jsonencode({
    openapi = "3.0.0"
    info    = { title = var.name, version = local.release_tag }
    paths   = local.route_paths
  })
  dynamic "log_options" {
    for_each = try(var.observability.platform_logs, null) != null ? [var.observability.platform_logs] : []
    content {
      disabled  = !log_options.value.enabled
      folder_id = log_options.value.enabled ? local.project_id : null
      min_level = log_options.value.enabled ? coalesce(log_options.value.min_level, "INFO") : null
    }
  }
  depends_on = [yandex_resourcemanager_folder_iam_member.runtime, yandex_iam_service_account_iam_member.deployer_use, yandex_function_iam_binding.invoker, yandex_storage_object.assets]
}

# These resources use Terraform's graph and backend lock. The CLI does not run
# a parallel scheduler or maintain a second cloud resource database.
resource "terraform_data" "legacy_pin" {
  count            = try(var.cloud_action.legacy_manifest, null) != null ? 1 : 0
  triggers_replace = [var.release_id]
  provisioner "local-exec" {
    interpreter = concat(var.cloud_action.interpreter, ["pin"])
    command     = var.cloud_action.legacy_manifest
  }
  lifecycle { create_before_destroy = true }
}

resource "terraform_data" "migrations" {
  for_each = { for name, database in var.databases : name => database if database.migrations && var.cloud_action != null }
  triggers_replace = [
    yandex_ydb_database_serverless.databases[each.key].id,
    sha256(jsonencode({ for file in fileset("${local.artifacts}/databases/${each.key}/migrations", "**") : file => filesha256("${local.artifacts}/databases/${each.key}/migrations/${file}") }))
  ]
  provisioner "local-exec" {
    interpreter = concat(var.cloud_action.interpreter, ["migrate"])
    command = jsonencode({
      project    = var.cloud_action.project
      connection = yandex_ydb_database_serverless.databases[each.key].ydb_full_endpoint
      directory  = abspath("${local.artifacts}/databases/${each.key}/migrations")
    })
  }
  lifecycle { create_before_destroy = true }
}

resource "terraform_data" "release" {
  input      = var.publication_record
  depends_on = [yandex_api_gateway.gateway, yandex_function_trigger.crons, yandex_function_trigger.triggers, terraform_data.migrations]
}
