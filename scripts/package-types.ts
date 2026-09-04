export interface PackageManifest {
  name: string
  version: string
  license?: string
  description?: string
  repository?: { url?: string, directory?: string }
  engines?: { node?: string }
  main?: string
  types?: string
  bin?: Record<string, string>
  exports?: unknown
  files?: string[]
  scripts?: Record<string, string>
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
}

export interface PackedPackage {
  filename: string
  files: { path: string }[]
}

export interface ArtifactDigests {
  integrity: string
  shasum: string
}

export interface ReleaseArtifact extends ArtifactDigests {
  name: string
  tarball: string
}

export interface RegistryMetadata {
  "versions"?: Record<string, { dist?: Partial<ArtifactDigests> }>
  "dist-tags"?: Record<string, string>
}
