locals {
  monitoring_dashboard_name = length("${var.name}-serverless-red") <= 63 ? "${var.name}-serverless-red" : "${trimsuffix(substr(var.name, 0, 48), "-")}-${substr(sha256("${var.name}-serverless-red"), 0, 8)}-red"
  monitoring_function_names = sort(values(local.function_names))

  monitoring_gateway_charts = [
    {
      id        = "gateway-rate"
      x         = 0
      title     = "Request rate"
      query     = "series_sum([\"path\", \"operation\"], api_gateway.requests_count_per_second{service='serverless-apigateway', gateway='${var.name}', release='stable', operation!='total', path!='total'})"
      axis      = "requests/s"
      precision = 3
    },
    {
      id        = "gateway-errors"
      x         = 12
      title     = "Errors"
      query     = "series_sum([\"path\", \"operation\", \"code\"], api_gateway.errors_count_per_second{service='serverless-apigateway', gateway='${var.name}', release='stable', operation!='total', path!='total'})"
      axis      = "errors/s"
      precision = 3
    },
    {
      id        = "gateway-p95"
      x         = 24
      title     = "p95 latency"
      query     = "histogram_percentile(95, api_gateway.requests_latency_milliseconds{service='serverless-apigateway', gateway='${var.name}', release='stable', operation!='total', path!='total'})"
      axis      = "milliseconds"
      precision = 1
    },
  ]

  monitoring_function_charts = [
    {
      id        = "function-rate"
      x         = 0
      title     = "{{function}} — invocation rate"
      query     = "series_sum(\"function\", serverless.functions.started_per_second{service='serverless-functions', function='{{function}}'})"
      axis      = "invocations/s"
      precision = 3
    },
    {
      id        = "function-errors"
      x         = 12
      title     = "{{function}} — errors"
      query     = "series_sum(\"function\", serverless.functions.errors_per_second{service='serverless-functions', function='{{function}}'})"
      axis      = "errors/s"
      precision = 3
    },
    {
      id        = "function-p95"
      x         = 24
      title     = "{{function}} — p95 duration"
      query     = "histogram_percentile(95, serverless.functions.execution_time_milliseconds{service='serverless-functions', function='{{function}}'})"
      axis      = "milliseconds"
      precision = 1
    },
  ]
}

resource "yandex_monitoring_dashboard" "serverless_red" {
  folder_id   = local.project_id
  name        = local.monitoring_dashboard_name
  title       = "${var.name} — Serverless RED"
  description = "Automatic API Gateway and Cloud Functions RED metrics for ${var.name}."
  labels = {
    managed-by = "vibecloud"
  }

  dynamic "parametrization" {
    for_each = length(local.monitoring_function_names) > 0 ? [local.monitoring_function_names[0]] : []
    content {
      parameters {
        id          = "function"
        title       = "Function"
        description = "Cloud Function to observe"
        custom {
          values          = local.monitoring_function_names
          default_values  = [parametrization.value]
          multiselectable = false
        }
      }
    }
  }

  widgets {
    position {
      x = 0
      y = 0
      w = 36
      h = 2
    }
    title {
      text = "API Gateway"
      size = "TITLE_SIZE_M"
    }
  }

  dynamic "widgets" {
    for_each = local.monitoring_gateway_charts
    content {
      position {
        x = widgets.value.x
        y = 2
        w = 12
        h = 8
      }
      chart {
        chart_id       = widgets.value.id
        title          = widgets.value.title
        display_legend = true
        queries {
          target {
            query     = widgets.value.query
            text_mode = true
          }
          downsampling {
            gap_filling      = "GAP_FILLING_UNSPECIFIED"
            grid_aggregation = "GRID_AGGREGATION_UNSPECIFIED"
          }
        }
        visualization_settings {
          type        = "VISUALIZATION_TYPE_LINE"
          interpolate = "INTERPOLATE_LINEAR"
          color_scheme_settings {
            automatic {}
          }
          yaxis_settings {
            left {
              type        = "YAXIS_TYPE_LINEAR"
              title       = widgets.value.axis
              min         = "0"
              unit_format = "UNIT_NONE"
              precision   = widgets.value.precision
            }
            right {
              type        = "YAXIS_TYPE_LINEAR"
              unit_format = "UNIT_NONE"
              precision   = widgets.value.precision
            }
          }
        }
      }
    }
  }

  dynamic "widgets" {
    for_each = length(local.monitoring_function_names) > 0 ? [true] : []
    content {
      position {
        x = 0
        y = 10
        w = 36
        h = 2
      }
      title {
        text = "Cloud Functions"
        size = "TITLE_SIZE_M"
      }
    }
  }

  dynamic "widgets" {
    for_each = length(local.monitoring_function_names) > 0 ? local.monitoring_function_charts : []
    content {
      position {
        x = widgets.value.x
        y = 12
        w = 12
        h = 8
      }
      chart {
        chart_id       = widgets.value.id
        title          = widgets.value.title
        display_legend = true
        queries {
          target {
            query     = widgets.value.query
            text_mode = true
          }
          downsampling {
            gap_filling      = "GAP_FILLING_UNSPECIFIED"
            grid_aggregation = "GRID_AGGREGATION_UNSPECIFIED"
          }
        }
        visualization_settings {
          type        = "VISUALIZATION_TYPE_LINE"
          interpolate = "INTERPOLATE_LINEAR"
          color_scheme_settings {
            automatic {}
          }
          yaxis_settings {
            left {
              type        = "YAXIS_TYPE_LINEAR"
              title       = widgets.value.axis
              min         = "0"
              unit_format = "UNIT_NONE"
              precision   = widgets.value.precision
            }
            right {
              type        = "YAXIS_TYPE_LINEAR"
              unit_format = "UNIT_NONE"
              precision   = widgets.value.precision
            }
          }
        }
      }
    }
  }
}
