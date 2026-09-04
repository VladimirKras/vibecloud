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
  type    = map(object({ cloud_name = optional(string) }))
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
