import { createHash, timingSafeEqual } from "node:crypto";

export const MAX_NPM_PACKAGE_LOCK_ARTIFACT_BYTES = 2 * 1024 * 1024;
export const MAX_NPM_PACKAGE_LOCK_ARTIFACT_BASE64_LENGTH = Math.ceil(MAX_NPM_PACKAGE_LOCK_ARTIFACT_BYTES / 3) * 4;
export const SUPPORTED_NPM_LOCKFILE_VERSIONS = new Set([2, 3]);

export type NpmPackageLockArtifactTransport = {
  kind: "npm_package_lock";
  path: "package-lock.json";
  encoding: "base64";
  content: string;
  byteLength: number;
  sha256: string;
};

export type VerifiedNpmPackageLockArtifact = {
  kind: "npm_package_lock";
  path: "package-lock.json";
  content: string;
  bytes: Uint8Array;
  byteLength: number;
  sha256: string;
  lockfileVersion: 2 | 3;
};

export type NpmPackageLockExpectation = {
  dependencyName: string;
  dependencyType: "dependency" | "devDependency" | "peerDependency" | "optionalDependency";
  targetVersion: string;
};

export type NpmPackageLockValidationBinding = {
  validationRunId: string;
  proposedFixId: string;
  baseCommitSha: string;
};

export type NpmPackageLockArtifactFailure =
  | "invalid_artifact_fields"
  | "invalid_artifact_encoding"
  | "artifact_oversized"
  | "artifact_byte_length_mismatch"
  | "artifact_digest_mismatch"
  | "artifact_invalid_utf8"
  | "artifact_invalid_json"
  | "artifact_unsupported_lockfile_version"
  | "artifact_invalid_root_package"
  | "artifact_dependency_mismatch";

export function getNpmPackageLockArtifactShapeFailure(value: unknown): NpmPackageLockArtifactFailure | null {
  if (!isRecord(value)
    || !hasExactKeys(value, ["kind", "path", "encoding", "content", "byteLength", "sha256"])
    || value.kind !== "npm_package_lock"
    || value.path !== "package-lock.json"
    || value.encoding !== "base64"
    || typeof value.content !== "string"
    || typeof value.byteLength !== "number"
    || !Number.isSafeInteger(value.byteLength)
    || value.byteLength <= 0
    || typeof value.sha256 !== "string"
    || !/^[a-f\d]{64}$/.test(value.sha256)) return "invalid_artifact_fields";
  if (value.byteLength > MAX_NPM_PACKAGE_LOCK_ARTIFACT_BYTES || value.content.length > MAX_NPM_PACKAGE_LOCK_ARTIFACT_BASE64_LENGTH) return "artifact_oversized";
  if (!isCanonicalBase64(value.content)) return "invalid_artifact_encoding";
  return null;
}

export function verifyNpmPackageLockArtifact(
  value: unknown,
  expectation?: NpmPackageLockExpectation,
): { kind: "valid"; artifact: VerifiedNpmPackageLockArtifact } | { kind: "invalid"; reason: NpmPackageLockArtifactFailure } {
  const shapeFailure = getNpmPackageLockArtifactShapeFailure(value);
  if (shapeFailure) return { kind: "invalid", reason: shapeFailure };
  const artifact = value as NpmPackageLockArtifactTransport;
  const bytes = Buffer.from(artifact.content, "base64");
  if (bytes.byteLength > MAX_NPM_PACKAGE_LOCK_ARTIFACT_BYTES) return { kind: "invalid", reason: "artifact_oversized" };
  if (bytes.byteLength !== artifact.byteLength) return { kind: "invalid", reason: "artifact_byte_length_mismatch" };

  const actualDigest = Buffer.from(createHash("sha256").update(bytes).digest("hex"));
  const suppliedDigest = Buffer.from(artifact.sha256);
  if (actualDigest.length !== suppliedDigest.length || !timingSafeEqual(actualDigest, suppliedDigest)) {
    return { kind: "invalid", reason: "artifact_digest_mismatch" };
  }

  let content: string;
  try {
    content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return { kind: "invalid", reason: "artifact_invalid_utf8" };
  }

  let lockfile: unknown;
  try {
    lockfile = JSON.parse(content) as unknown;
  } catch {
    return { kind: "invalid", reason: "artifact_invalid_json" };
  }
  if (!isRecord(lockfile) || !SUPPORTED_NPM_LOCKFILE_VERSIONS.has(lockfile.lockfileVersion as number)) {
    return { kind: "invalid", reason: "artifact_unsupported_lockfile_version" };
  }
  if (!isRecord(lockfile.packages) || !isRecord(lockfile.packages[""])) {
    return { kind: "invalid", reason: "artifact_invalid_root_package" };
  }
  const root = lockfile.packages[""];
  if (expectation) {
    const section = getDependencySection(expectation.dependencyType);
    if (!isRecord(root[section]) || root[section][expectation.dependencyName] !== expectation.targetVersion) {
      return { kind: "invalid", reason: "artifact_dependency_mismatch" };
    }
  }

  return {
    kind: "valid",
    artifact: {
      kind: "npm_package_lock",
      path: "package-lock.json",
      content,
      bytes: new Uint8Array(bytes),
      byteLength: bytes.byteLength,
      sha256: artifact.sha256,
      lockfileVersion: lockfile.lockfileVersion as 2 | 3,
    },
  };
}

export function createNpmPackageLockArtifactTransport(content: string): NpmPackageLockArtifactTransport {
  const bytes = Buffer.from(content, "utf8");
  return {
    kind: "npm_package_lock",
    path: "package-lock.json",
    encoding: "base64",
    content: bytes.toString("base64"),
    byteLength: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

/** Requires the persisted artifact row to match every signed/server-resolved authority boundary. */
export function isNpmPackageLockValidationBindingCurrent(
  actual: NpmPackageLockValidationBinding,
  expected: NpmPackageLockValidationBinding,
) {
  return actual.validationRunId === expected.validationRunId
    && actual.proposedFixId === expected.proposedFixId
    && normalizeCommitSha(actual.baseCommitSha) !== null
    && normalizeCommitSha(actual.baseCommitSha) === normalizeCommitSha(expected.baseCommitSha);
}

function isCanonicalBase64(value: string) {
  if (value.length === 0 || value.length % 4 !== 0 || !/^(?:[A-Za-z\d+/]{4})*(?:[A-Za-z\d+/]{2}==|[A-Za-z\d+/]{3}=)?$/.test(value)) return false;
  return Buffer.from(value, "base64").toString("base64") === value;
}

function getDependencySection(type: NpmPackageLockExpectation["dependencyType"]) {
  if (type === "dependency") return "dependencies";
  if (type === "devDependency") return "devDependencies";
  if (type === "peerDependency") return "peerDependencies";
  return "optionalDependencies";
}

function normalizeCommitSha(value: string) {
  return /^(?:[a-f\d]{40}|[a-f\d]{64})$/i.test(value) ? value.toLowerCase() : null;
}

function hasExactKeys(value: Record<string, unknown>, expected: string[]) {
  const actual = Object.keys(value);
  return actual.length === expected.length && actual.every((key) => expected.includes(key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
