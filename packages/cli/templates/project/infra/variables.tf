variable "name" {
  description = "Application and project folder name."
  type        = string

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{2,62}$", var.name))
    error_message = "name must contain 3-63 lowercase letters, digits, or hyphens and start with a letter."
  }
}

variable "folder_id" {
  description = "YC folder ID resolved and recorded by Vibecloud initialization."
  type        = string
  nullable    = false
}

variable "deployer_subject" {
  description = "IAM subject running Terraform, allowed to attach the generated runtime service account."
  type        = string
  nullable    = false

  validation {
    condition     = can(regex("^(userAccount|serviceAccount|federatedUser):[a-zA-Z0-9_-]+$", var.deployer_subject))
    error_message = "deployer_subject must be a userAccount, serviceAccount, or federatedUser subject."
  }
}

variable "gateway" {
  type = object({
    routes = optional(list(object({
      pattern  = string
      method   = optional(string)
      function = optional(string)
      assets   = optional(string)
    })), [])
  })
}

variable "assets" {
  type = map(object({
    template   = optional(string)
    build      = optional(object({ command = string, cwd = optional(string) }))
    fallback   = optional(string)
    cloud_name = optional(string)
  }))
  default = {}
}

variable "functions" {
  type = map(object({
    template        = optional(string)
    handler         = string
    database        = optional(string)
    bucket          = optional(string)
    runtime         = optional(string, "nodejs22")
    build           = optional(object({ command = string, cwd = optional(string) }))
    memory_mb       = optional(number)
    timeout_seconds = optional(number)
    cron = optional(object({
      expression = string
      payload    = optional(string)
    }))
    triggers = optional(list(object({
      stream                 = string
      batch_size_bytes       = optional(number, 1)
      batch_cutoff_seconds   = optional(number, 1)
      retry_attempts         = optional(number, 1)
      retry_interval_seconds = optional(number, 10)
      dead_letter_queue      = optional(string)
    })), [])
  }))
  default = {}
}

variable "databases" {
  type = map(object({
    migrations = optional(bool, false)
    streams    = optional(map(object({})), {})
  }))
  default = {}
}

variable "buckets" {
  type    = map(object({ cloud_name = optional(string), public = optional(bool, false) }))
  default = {}
}

variable "vars" {
  type    = map(any)
  default = {}
}

variable "ai" {
  type = object({
    responses        = optional(bool, false)
    realtime         = optional(bool, false)
    speechkit_stt    = optional(bool, false)
    speechkit_tts    = optional(bool, false)
    image_generation = optional(bool, false)
  })
  default = {}
}

variable "secrets" {
  type     = object({ entries = map(object({})) })
  default  = null
  nullable = true
}

variable "observability" {
  type = object({
    logs = optional(object({
      enabled   = bool
      min_level = optional(string)
      cluster   = optional(string)
    }))
    platform_logs = optional(object({
      enabled   = bool
      min_level = optional(string)
    }))
    metrics = optional(object({
      enabled = bool
      cluster = optional(string)
    }))
    traces = optional(object({
      enabled     = bool
      sample_rate = optional(number, 0.1)
      cluster     = optional(string)
    }))
    source_maps = optional(bool, false)
  })
  default = {}
}

variable "artifact_directory" {
  description = "Immutable artifact directory selected by this deployment."
  type        = string
  default     = null
}

variable "deployment_plan" {
  description = "Compiled by Vibecloud from the selected declaration; shared with the build and local runtime."
  type = object({
    schema_version = number
    function_groups = map(object({
      kind            = string
      runtime         = string
      handler         = string
      memory_mb       = number
      timeout_seconds = number
      members         = list(string)
    }))
    function_group_keys = map(string)
    gateway_routes      = list(object({ pattern = string, method = string, function = string, assets = string }))
    timer_payloads      = map(string)
    databases           = list(string)
    ai                  = object({ responses = bool, realtime = bool, speechkit_stt = bool, speechkit_tts = bool, image_generation = bool })
  })
  validation {
    condition     = var.deployment_plan.schema_version == 2
    error_message = "Generate deployment inputs with the matching Vibecloud CLI."
  }
}

variable "release_id" {
  description = "Unique immutable release selected by pnpm push."
  type        = string
  default     = null
}

variable "retained_assets" {
  description = "Previous assets retained from the selected backend; no local source is needed."
  type = map(object({
    asset_key    = string
    file         = string
    source       = string
    source_hash  = string
    content_type = string
  }))
  default = {}
}

variable "publication_record" {
  description = "Artifact lineage only; Terraform state remains the resource authority."
  type        = object({ release_id = string, previous = string, protected = list(string) })
  default     = null
}

variable "cloud_action" {
  description = "Installed CLI adapter used by native Terraform provisioners."
  type        = object({ interpreter = list(string), project = string, legacy_manifest = string })
  default     = null
}
