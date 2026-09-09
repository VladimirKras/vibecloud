mock_provider "yandex" {}
mock_provider "archive" {}

run "selected_empty_configuration" {
  command = plan
  variables {
    functions       = jsondecode(file("./tests/inputs/selected_empty_configuration.json")).functions
    gateway         = jsondecode(file("./tests/inputs/selected_empty_configuration.json")).gateway
    databases       = jsondecode(file("./tests/inputs/selected_empty_configuration.json")).databases
    ai              = jsondecode(file("./tests/inputs/selected_empty_configuration.json")).ai
    deployment_plan = jsondecode(file("./tests/inputs/selected_empty_configuration.json")).deployment_plan
  }

  assert {
    condition     = length(yandex_storage_bucket.assets) == 0 && length(yandex_storage_bucket.buckets) == 0
    error_message = "Auto-loaded declarations leaked into the selected empty configuration."
  }
  assert {
    condition     = length(yandex_ydb_database_serverless.databases) == 0 && !local.responses_enabled
    error_message = "An empty application should not provision databases or enable AI."
  }
}

run "independent_database_resources" {
  command = plan
  variables {
    functions       = jsondecode(file("./tests/inputs/independent_database_resources.json")).functions
    gateway         = jsondecode(file("./tests/inputs/independent_database_resources.json")).gateway
    databases       = jsondecode(file("./tests/inputs/independent_database_resources.json")).databases
    ai              = jsondecode(file("./tests/inputs/independent_database_resources.json")).ai
    deployment_plan = jsondecode(file("./tests/inputs/independent_database_resources.json")).deployment_plan
  }

  assert {
    condition     = length(yandex_ydb_database_serverless.databases) == 2
    error_message = "Each database declaration must produce one database resource."
  }
  assert {
    condition     = yandex_ydb_database_serverless.databases["primary"].name != yandex_ydb_database_serverless.databases["analytics"].name
    error_message = "Logical databases must have distinct physical names."
  }
}

run "function_invocation_permissions" {
  command = plan
  variables {
    functions       = jsondecode(file("./tests/inputs/function_invocation_permissions.json")).functions
    gateway         = jsondecode(file("./tests/inputs/function_invocation_permissions.json")).gateway
    databases       = jsondecode(file("./tests/inputs/function_invocation_permissions.json")).databases
    ai              = jsondecode(file("./tests/inputs/function_invocation_permissions.json")).ai
    deployment_plan = jsondecode(file("./tests/inputs/function_invocation_permissions.json")).deployment_plan
  }

  assert {
    condition     = length(yandex_function_iam_binding.invoker) == 1
    error_message = "Each function needs its own invocation permission."
  }
  assert {
    condition     = !local.responses_enabled && !local.speechkit_stt_enabled && !local.speechkit_tts_enabled
    error_message = "A plain HTTP function must not acquire AI capabilities."
  }
}

run "shared_runtime_routers" {
  command = plan
  variables {
    functions       = jsondecode(file("./tests/inputs/shared_runtime_routers.json")).functions
    gateway         = jsondecode(file("./tests/inputs/shared_runtime_routers.json")).gateway
    databases       = jsondecode(file("./tests/inputs/shared_runtime_routers.json")).databases
    ai              = jsondecode(file("./tests/inputs/shared_runtime_routers.json")).ai
    deployment_plan = jsondecode(file("./tests/inputs/shared_runtime_routers.json")).deployment_plan
  }

  assert {
    condition     = toset(keys(yandex_function.functions)) == toset(["http-nodejs22", "timer-nodejs22", "websocket-nodejs22"]) && length(yandex_function_iam_binding.invoker) == 3
    error_message = "Six logical handlers should deploy as three functions with three invocation bindings."
  }
  assert {
    condition     = yandex_function.functions["http-nodejs22"].memory == 512 && yandex_function.functions["http-nodejs22"].execution_timeout == "60" && yandex_function.functions["timer-nodejs22"].entrypoint == "router.handler"
    error_message = "Shared runtime settings and entrypoints must match the grouped build."
  }
  assert {
    condition     = toset(keys(local.route_paths)) == toset(["/", "/{path+}", "/ws-one", "/ws-two"])
    error_message = "HTTP handler routes must dispatch inside the function, through two gateway transport endpoints."
  }
  assert {
    condition     = yandex_function_trigger.crons["daily"].timer[0].payload == "daily" && yandex_function_trigger.crons["hourly"].timer[0].payload == "hourly"
    error_message = "Timers must carry an unambiguous logical dispatch key."
  }
}

run "mixed_runtimes_and_stream_isolation" {
  command = plan
  variables {
    functions       = jsondecode(file("./tests/inputs/mixed_runtimes_and_stream_isolation.json")).functions
    gateway         = jsondecode(file("./tests/inputs/mixed_runtimes_and_stream_isolation.json")).gateway
    databases       = jsondecode(file("./tests/inputs/mixed_runtimes_and_stream_isolation.json")).databases
    ai              = jsondecode(file("./tests/inputs/mixed_runtimes_and_stream_isolation.json")).ai
    deployment_plan = jsondecode(file("./tests/inputs/mixed_runtimes_and_stream_isolation.json")).deployment_plan
  }

  assert {
    condition     = toset(keys(yandex_function.functions)) == toset(["http-nodejs22", "http-python312", "stream-one", "stream-two"])
    error_message = "Exact runtime versions and unidentified stream consumers must remain separate."
  }
}

run "membership_initial" {
  command = apply
  variables {
    functions       = jsondecode(file("./tests/inputs/membership_initial.json")).functions
    gateway         = jsondecode(file("./tests/inputs/membership_initial.json")).gateway
    databases       = jsondecode(file("./tests/inputs/membership_initial.json")).databases
    ai              = jsondecode(file("./tests/inputs/membership_initial.json")).ai
    deployment_plan = jsondecode(file("./tests/inputs/membership_initial.json")).deployment_plan
  }

}

run "membership_added" {
  command = apply
  variables {
    functions       = jsondecode(file("./tests/inputs/membership_added.json")).functions
    gateway         = jsondecode(file("./tests/inputs/membership_added.json")).gateway
    databases       = jsondecode(file("./tests/inputs/membership_added.json")).databases
    ai              = jsondecode(file("./tests/inputs/membership_added.json")).ai
    deployment_plan = jsondecode(file("./tests/inputs/membership_added.json")).deployment_plan
  }

  assert {
    condition     = output.test_function_ids == run.membership_initial.test_function_ids && length(yandex_function_trigger.crons) == 2
    error_message = "Adding members must update versions and triggers without replacing shared functions."
  }
}

run "membership_removed_originals" {
  command = apply
  variables {
    functions       = jsondecode(file("./tests/inputs/membership_removed_originals.json")).functions
    gateway         = jsondecode(file("./tests/inputs/membership_removed_originals.json")).gateway
    databases       = jsondecode(file("./tests/inputs/membership_removed_originals.json")).databases
    ai              = jsondecode(file("./tests/inputs/membership_removed_originals.json")).ai
    deployment_plan = jsondecode(file("./tests/inputs/membership_removed_originals.json")).deployment_plan
  }

  assert {
    condition     = output.test_function_ids == run.membership_initial.test_function_ids && length(yandex_function_trigger.crons) == 1
    error_message = "Removing original members must preserve the groups and the remaining timer."
  }
}

run "membership_removed_last_timer_and_socket" {
  command = apply
  variables {
    functions       = jsondecode(file("./tests/inputs/membership_removed_last_timer_and_socket.json")).functions
    gateway         = jsondecode(file("./tests/inputs/membership_removed_last_timer_and_socket.json")).gateway
    databases       = jsondecode(file("./tests/inputs/membership_removed_last_timer_and_socket.json")).databases
    ai              = jsondecode(file("./tests/inputs/membership_removed_last_timer_and_socket.json")).ai
    deployment_plan = jsondecode(file("./tests/inputs/membership_removed_last_timer_and_socket.json")).deployment_plan
  }

  assert {
    condition     = length(yandex_function.functions) == 1 && yandex_function.functions["http-nodejs22"].id == run.membership_initial.test_function_ids["http-nodejs22"] && length(yandex_function_trigger.crons) == 0
    error_message = "Removing the last member should delete only its empty group and triggers."
  }
}

run "membership_removed_all" {
  command = apply
  variables {
    functions       = jsondecode(file("./tests/inputs/membership_removed_all.json")).functions
    gateway         = jsondecode(file("./tests/inputs/membership_removed_all.json")).gateway
    databases       = jsondecode(file("./tests/inputs/membership_removed_all.json")).databases
    ai              = jsondecode(file("./tests/inputs/membership_removed_all.json")).ai
    deployment_plan = jsondecode(file("./tests/inputs/membership_removed_all.json")).deployment_plan
  }

  assert {
    condition     = length(yandex_function.functions) == 0 && length(yandex_function_iam_binding.invoker) == 0 && length(local.route_paths) == 0
    error_message = "Removing the final function must leave no function, invoker binding, or function route."
  }
}

run "image_generation_permissions" {
  command = plan
  variables {
    buckets         = jsondecode(file("./tests/inputs/image_generation_permissions.json")).buckets
    functions       = jsondecode(file("./tests/inputs/image_generation_permissions.json")).functions
    gateway         = jsondecode(file("./tests/inputs/image_generation_permissions.json")).gateway
    databases       = jsondecode(file("./tests/inputs/image_generation_permissions.json")).databases
    ai              = jsondecode(file("./tests/inputs/image_generation_permissions.json")).ai
    deployment_plan = jsondecode(file("./tests/inputs/image_generation_permissions.json")).deployment_plan
  }

  assert {
    condition     = local.image_generation_enabled && contains(local.runtime_roles, "ai.models.user") && !contains(local.runtime_roles, "ai.imageGeneration.user")
    error_message = "Alice AI ART must receive the current model role, not the retired YandexART role."
  }
  assert {
    condition     = yandex_function.functions["http-nodejs22"].execution_timeout == "120" && yandex_function.functions["http-nodejs22"].memory == 256
    error_message = "Synchronous image generation requires its compiled deadline and memory defaults."
  }
}

run "immutable_publication" {
  command = apply
  variables {
    release_id      = "r-300"
    assets          = jsondecode(file("./tests/inputs/immutable_publication.json")).assets
    functions       = jsondecode(file("./tests/inputs/immutable_publication.json")).functions
    gateway         = jsondecode(file("./tests/inputs/immutable_publication.json")).gateway
    deployment_plan = jsondecode(file("./tests/inputs/immutable_publication.json")).deployment_plan
    retained_assets = {
      "website/_vibecloud/releases/r-200/website/old.js" = {
        asset_key    = "website"
        file         = "_vibecloud/releases/r-200/website/old.js"
        source       = null
        source_hash  = null
        content_type = "text/javascript; charset=utf-8"
      }
    }
  }
  assert {
    condition     = yandex_function.functions["http-nodejs22"].tags == toset(["r-300"]) && local.route_paths["/api"].x-yc-apigateway-any-method.x-yc-apigateway-integration.tag == "r-300"
    error_message = "HTTP calls must target the immutable release, never $latest."
  }
  assert {
    condition     = local.route_paths["/"].get.x-yc-apigateway-integration.object == "_vibecloud/releases/r-300/website/index.html" && local.route_paths["/"].get.x-yc-apigateway-integration.error_object == "_vibecloud/releases/r-300/website/index.html"
    error_message = "HTML and SPA fallbacks must switch to the same release."
  }
  assert {
    condition     = local.route_paths["/_vibecloud/releases/r-200/website/{path+}"].get.x-yc-apigateway-integration.object == "_vibecloud/releases/r-200/website/{path}" && contains(keys(yandex_storage_object.assets), "website/_vibecloud/releases/r-200/website/old.js") && !contains(keys(local.route_paths), "/_vibecloud/releases/{release}/website/{path+}")
    error_message = "Previous browser asset URLs must remain routable."
  }
  assert {
    condition     = contains(keys(yandex_storage_object.assets), "website/_vibecloud/releases/r-300/website/index.html")
    error_message = "The new release must upload immutable HTML."
  }
}

run "unrouted_assets" {
  command = plan
  variables {
    release_id      = "r-400"
    assets          = jsondecode(file("./tests/inputs/unrouted_assets.json")).assets
    functions       = {}
    gateway         = jsondecode(file("./tests/inputs/unrouted_assets.json")).gateway
    deployment_plan = jsondecode(file("./tests/inputs/unrouted_assets.json")).deployment_plan
    retained_assets = {
      "website/legacy.js" = { asset_key = "website", file = "legacy.js", source = null, source_hash = null, content_type = "text/javascript" }
      "website/old.js"    = { asset_key = "website", file = "_vibecloud/releases/r-200/website/old.js", source = null, source_hash = null, content_type = "text/javascript" }
    }
  }
  assert {
    condition     = length(local.route_paths) == 0
    error_message = "Removing asset routes must unpublish current, retained, and legacy downloads."
  }
}

run "exact_asset_route" {
  command = plan
  variables {
    release_id      = "r-400"
    assets          = jsondecode(file("./tests/inputs/exact_asset_route.json")).assets
    functions       = {}
    gateway         = jsondecode(file("./tests/inputs/exact_asset_route.json")).gateway
    deployment_plan = jsondecode(file("./tests/inputs/exact_asset_route.json")).deployment_plan
    retained_assets = {
      "website/legacy.js" = { asset_key = "website", file = "legacy.js", source = null, source_hash = null, content_type = "text/javascript" }
      "website/old.js"    = { asset_key = "website", file = "_vibecloud/releases/r-200/website/old.js", source = null, source_hash = null, content_type = "text/javascript" }
    }
  }
  assert {
    condition     = toset(keys(local.route_paths)) == toset(["/index.html", "/_vibecloud/releases/r-400/website/index.html", "/_vibecloud/releases/r-200/website/index.html"])
    error_message = "An exact file route must not expose wildcard release downloads or unrelated legacy files."
  }
}

run "renamed_asset" {
  command = plan
  variables {
    release_id      = "r-400"
    assets          = jsondecode(file("./tests/inputs/renamed_asset.json")).assets
    functions       = {}
    gateway         = jsondecode(file("./tests/inputs/renamed_asset.json")).gateway
    deployment_plan = jsondecode(file("./tests/inputs/renamed_asset.json")).deployment_plan
    retained_assets = {
      "renamed/old.js" = { asset_key = "renamed", file = "_vibecloud/releases/r-200/website/old.js", source = null, source_hash = null, content_type = "text/javascript" }
    }
  }
  assert {
    condition     = local.route_paths["/_vibecloud/releases/r-200/website/{path+}"].get.x-yc-apigateway-integration.object == "_vibecloud/releases/r-200/website/{path}" && contains(keys(yandex_storage_object.assets), "renamed/old.js")
    error_message = "Logical asset renames must preserve retained bytes and their original release URLs."
  }
}
