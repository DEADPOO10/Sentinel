import "server-only";

import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { access, mkdir, mkdtemp, open as openFile, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import * as yauzl from "yauzl";
import { getGitHubAccessTokenForCurrentUser } from "@/lib/github/repositories";
import type { ProposedFix } from "@/lib/openai/proposed-fix";

const GITHUB_API_ORIGIN = "https://api.github.com/";
const SENSITIVE_FILE_NAMES = new Set([".npmrc", ".yarnrc", ".yarnrc.yml", ".pypirc", "credentials", "credentials.json", "secrets", "secrets.json", "id_rsa"]);
const GENERATED_DIRECTORY_NAMES = new Set(["node_modules", ".next", "dist", "build", "coverage"]);

export const PROPOSED_FIX_VALIDATION_LIMITS = {
  maxArchiveBytes: 25 * 1024 * 1024,
  maxRepositoryBytes: 100 * 1024 * 1024,
  maxTotalDurationMs: 5 * 60 * 1_000,
  maxCommandDurationMs: 90 * 1_000,
  maxCommandOutputBytes: 24 * 1024,
  maxCommands: 5,
  archiveRequestTimeoutMs: 30 * 1_000,
} as const;

type OverallValidationStatus = "passed" | "failed" | "partial" | "unable_to_validate";
type InstallStatus = "passed" | "failed" | "skipped";
type CheckName = "typecheck" | "lint" | "test" | "build";
type CheckStatus = "passed" | "failed" | "skipped" | "timed_out";
type PackageManager = "npm" | "pnpm" | "yarn";
type PackageManagerMode = "lockfile" | "package_json_fallback";
export type ProposedFixValidationPartialReason = "skipped_checks" | "no_lockfile_fallback" | "cleanup_unconfirmed";
type PackageManagerDetection = { kind: "ready"; manager: PackageManager; mode: PackageManagerMode } | { kind: "ambiguous" } | { kind: "missing" };
type ValidationManifest = { scripts: Record<string, string>; packageManager: string | null };
type WorkspacePreparationStage = "temp_directory_create" | "archive_download" | "archive_http_error" | "archive_too_large" | "archive_extract" | "extracted_root_missing" | "sanitize_repository" | "repository_too_large" | "package_json_missing" | "patch_preparation" | "filesystem_permission" | "unexpected_workspace_error";
type SafeWorkspaceFailureDetails = Record<string, string | number | boolean | null>;
type CommandTerminationReason = "command_timeout" | "total_validation_timeout" | "request_aborted" | "cleanup" | "execution_error" | "unknown_internal_termination";
const VALIDATION_CHECK_NAMES: CheckName[] = ["typecheck", "lint", "test", "build"];

export type ProposedFixValidationResult = {
  overallStatus: OverallValidationStatus;
  baseBranch: string | null;
  baseCommitSha: string | null;
  install: { status: InstallStatus; summary: string };
  checks: Array<{
    name: CheckName;
    status: CheckStatus;
    durationMs: number;
    summary: string;
  }>;
  warnings: string[];
  partialReasons: ProposedFixValidationPartialReason[];
};

type ValidationInput = {
  owner: string;
  repository: string;
  defaultBranch: string;
  baseCommitSha: string;
  dependencyType: "dependency" | "devDependency" | "peerDependency" | "optionalDependency";
  proposedFix: ProposedFix;
};

type CommandResult = {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  terminationReason: CommandTerminationReason | null;
  durationMs: number;
  timedOut: boolean;
  outputTruncated: boolean;
  commandUnavailable: boolean;
  spawnFailed: boolean;
  executionError: boolean;
};

type ValidationChecksResult = {
  checks: ProposedFixValidationResult["checks"];
  warnings: string[];
};

type ArchiveMetadata = {
  format: "zip";
  byteSize: number;
};

export async function validateProposedFixInTemporaryWorkspace(input: ValidationInput): Promise<ProposedFixValidationResult> {
  const runtimeUnavailableMessage = getValidationRuntimeUnavailableMessage();
  if (runtimeUnavailableMessage) {
    return addValidationBase(createUnableToValidateResult(runtimeUnavailableMessage), input);
  }
  if (!isSafeGitCommitSha(input.baseCommitSha)) {
    return addValidationBase(createUnableToValidateResult("The repository base commit could not be safely prepared for validation."), input);
  }

  let temporaryRoot: string | null = null;
  let result: ProposedFixValidationResult = createUnableToValidateResult("Validation could not start.");

  try {
    const accessToken = await getGitHubAccessTokenForCurrentUser();
    if (!accessToken) {
      result = createUnableToValidateResult("GitHub authorization is unavailable for isolated validation.");
      return addValidationBase(result, input);
    }

    let archivePath: string;
    let extractionPath: string;
    let homePath: string;
    let cachePath: string;
    try {
      temporaryRoot = await mkdtemp(join(tmpdir(), "sentinel-validation-"));
      archivePath = join(temporaryRoot, "repository.zip");
      extractionPath = join(temporaryRoot, "extracted");
      homePath = join(temporaryRoot, "home");
      cachePath = join(temporaryRoot, "cache");
      await Promise.all([mkdir(extractionPath), mkdir(homePath), mkdir(cachePath)]);
      await mkdir(join(homePath, "tmp"));
    } catch (error) {
      if (error instanceof ValidationRuntimeError) throw error;
      throw createWorkspacePreparationError(error, "workspace_error", "temp_directory_create");
    }
    result = await runValidationWorkflow({ input, accessToken, archivePath, extractionPath, homePath, cachePath, temporaryRoot });
  } catch (error) {
    const category = getValidationFailureCategory(error);
    const workspaceFailure = getWorkspaceFailureDiagnostic(error, category);
    logWorkspaceFailure(workspaceFailure.stage, workspaceFailure.details);
    result = createUnableToValidateResult(category === "runtime_unavailable" ? "Validation runtime unavailable in this environment." : "Sentinel could not prepare an isolated validation workspace.");
  } finally {
    if (temporaryRoot) {
      try {
        await rm(temporaryRoot, { recursive: true, force: true, maxRetries: 2 });
        logSafeValidationEvent("cleanup_finished", { status: "passed" });
      } catch {
        logSafeValidationEvent("cleanup_finished", { status: "failed" });
        result = addCleanupWarning(result);
      }
    }
  }

  return addValidationBase(result, input);
}

/**
 * A temporary directory is useful local containment, but it is not a sandbox.
 * Do not execute untrusted repository commands inside a production web function.
 */
function getValidationRuntimeUnavailableMessage() {
  if (process.env.NODE_ENV === "production") {
    logSafeValidationEvent("runtime_disabled", { reason: "production_host_execution_guard" });
    return "Repository command validation is unavailable in this production environment until Sentinel uses a dedicated isolated validation worker.";
  }
  if (process.env.SENTINEL_VALIDATION_ENABLED !== "true") {
    return "Validation runtime unavailable in this environment. Enable the isolated local validation runtime to run repository commands.";
  }
  return null;
}

async function runValidationWorkflow(input: {
  input: ValidationInput;
  accessToken: string;
  archivePath: string;
  extractionPath: string;
  homePath: string;
  cachePath: string;
  temporaryRoot: string;
}): Promise<ProposedFixValidationResult> {
  const deadline = Date.now() + PROPOSED_FIX_VALIDATION_LIMITS.maxTotalDurationMs;
  await downloadRepositoryArchive(input.input, input.accessToken, input.archivePath, getRemainingValidationTimeout(deadline, PROPOSED_FIX_VALIDATION_LIMITS.archiveRequestTimeoutMs));
  const workspace = await extractRepositoryArchive(input.archivePath, input.extractionPath, input.temporaryRoot, getRemainingValidationTimeout(deadline, PROPOSED_FIX_VALIDATION_LIMITS.maxCommandDurationMs));
  const sanitization = await sanitizeWorkspace(workspace);
  if (Date.now() >= deadline) return createUnableToValidateResult("The isolated validation time limit was reached while preparing the repository workspace.");
  if (sanitization.bytes > PROPOSED_FIX_VALIDATION_LIMITS.maxRepositoryBytes) {
    logWorkspaceFailure("repository_too_large", { byteSize: sanitization.bytes });
    return createUnableToValidateResult("The repository exceeds Sentinel's isolated validation size limit.");
  }

  const manifest = await readValidationManifest(workspace);
  if (!manifest) {
    return createUnableToValidateResult("No readable package.json was found in the isolated repository workspace.");
  }

  let application: PatchApplicationResult;
  try {
    application = await applyVerifiedProposedFix(workspace, input.input.proposedFix, input.input.dependencyType);
  } catch (error) {
    throw createWorkspacePreparationError(error, "workspace_error", "patch_preparation");
  }
  if (!application.applied) {
    logWorkspaceFailure("patch_preparation", { category: application.category });
    logSafeValidationEvent("patch_application_failed", { category: application.category });
    return createUnableToValidateResult("Sentinel could not verify the proposed changes against the current repository copy.");
  }

  const packageManager = await detectPackageManager(workspace, manifest);
  if (packageManager.kind === "ambiguous") return createUnableToValidateResult("Sentinel could not safely determine the repository package manager.");
  if (packageManager.kind === "missing") return createUnableToValidateResult("Sentinel could not safely use the no-lockfile npm fallback for this repository.");
  logSafeValidationEvent("package_manager_selected", { manager: packageManager.manager, mode: packageManager.mode });

  const environment = createSafeCommandEnvironment(input.homePath, input.cachePath);
  const installCommand = getInstallCommand(packageManager.manager, packageManager.mode, input.input.proposedFix.packageJsonChange.required);
  const installTimeoutMs = getRemainingCommandTimeout(deadline);
  if (installTimeoutMs <= 0) return createUnableToValidateResult("The isolated validation time limit was reached before dependency installation could start.");
  const installExecution = await runLimitedCommand(installCommand.command, installCommand.args, workspace, environment, installTimeoutMs, "install", getCommandTimeoutReason(deadline));
  logCommandCompletion("install", installExecution);

  if (installExecution.commandUnavailable) {
    return createUnableToValidateResult(`${packageManager.manager} is unavailable in the isolated validation runtime.`);
  }
  if (!isSuccessfulCommand(installExecution)) {
    return {
      overallStatus: "failed",
      baseBranch: null,
      baseCommitSha: null,
      install: { status: "failed", summary: getInstallFailureSummary(installExecution) },
      checks: createSkippedChecks("Skipped because dependency installation did not complete."),
      warnings: [
        ...getBaseWarnings(sanitization.removedEntries, input.input.proposedFix.packageJsonChange.required, packageManager.mode),
        ...getOutputTruncationWarnings([{ stage: "install", result: installExecution }]),
      ],
      partialReasons: [],
    };
  }

  const validationChecks = await runValidationChecks(manifest.scripts, packageManager.manager, workspace, environment, deadline);
  const { checks } = validationChecks;
  const warnings = [
    ...getBaseWarnings(sanitization.removedEntries, input.input.proposedFix.packageJsonChange.required, packageManager.mode),
    ...getOutputTruncationWarnings([{ stage: "install", result: installExecution }]),
    ...validationChecks.warnings,
  ];
  const executedChecks = checks.filter((check) => check.status !== "skipped");
  const failedCheck = checks.some((check) => check.status === "failed" || check.status === "timed_out");
  const skippedCheck = checks.some((check) => check.status === "skipped");
  if (executedChecks.length === 0) {
    return {
      overallStatus: "unable_to_validate",
      baseBranch: null,
      baseCommitSha: null,
      install: { status: "passed", summary: getInstallSuccessSummary(packageManager.mode) },
      checks,
      warnings: [...warnings, "No supported typecheck, lint, test, or build scripts were found."],
      partialReasons: [],
    };
  }

  return {
    overallStatus: failedCheck ? "failed" : skippedCheck || packageManager.mode === "package_json_fallback" ? "partial" : "passed",
    baseBranch: null,
    baseCommitSha: null,
    install: { status: "passed", summary: getInstallSuccessSummary(packageManager.mode) },
    checks,
    warnings,
    partialReasons: [
      ...(skippedCheck ? ["skipped_checks" as const] : []),
      ...(packageManager.mode === "package_json_fallback" ? ["no_lockfile_fallback" as const] : []),
    ],
  };
}

async function downloadRepositoryArchive(input: Omit<ValidationInput, "proposedFix">, accessToken: string, archivePath: string, timeoutMs: number) {
  if (timeoutMs <= 0) throw new ValidationRuntimeError("validation_time_limit", "archive_download", { timeoutCategory: "validation_time_limit" });
  const archiveUrl = new URL(`/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repository)}/zipball/${encodeURIComponent(input.baseCommitSha)}`, GITHUB_API_ORIGIN);
  let response: Response;
  try {
    response = await fetch(archiveUrl, {
      headers: githubHeaders(accessToken),
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw createWorkspacePreparationError(error, "repository_fetch_failed", "archive_download");
  }
  if (!response.ok) {
    throw new ValidationRuntimeError("repository_fetch_failed", "archive_http_error", {
      httpStatus: response.status,
      httpStatusCategory: getHttpStatusCategory(response.status),
    });
  }

  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > PROPOSED_FIX_VALIDATION_LIMITS.maxArchiveBytes) {
    throw new ValidationRuntimeError("archive_too_large", "archive_too_large", { byteSize: declaredLength });
  }

  let archive: Uint8Array;
  try {
    archive = await readBoundedResponseBytes(response, PROPOSED_FIX_VALIDATION_LIMITS.maxArchiveBytes);
  } catch (error) {
    if (error instanceof ValidationRuntimeError) throw error;
    throw createWorkspacePreparationError(error, "repository_fetch_failed", "archive_download");
  }
  try {
    await writeFile(archivePath, archive);
  } catch (error) {
    throw createWorkspacePreparationError(error, "workspace_error", "archive_download");
  }
}

async function extractRepositoryArchive(archivePath: string, extractionPath: string, temporaryRoot: string, timeoutMs: number) {
  if (timeoutMs <= 0) throw new ValidationRuntimeError("validation_time_limit", "archive_extract", { timeoutCategory: "validation_time_limit" });

  const archive = await validateDownloadedArchive(archivePath);
  logSafeValidationEvent("archive_extraction_started", {
    extractionTool: "yauzl",
    archiveFormat: archive.format,
    archiveExists: true,
    archiveByteSize: archive.byteSize,
  });

  const abortController = new AbortController();
  let timedOut = false;
  let zipFile: yauzl.ZipFile | null = null;
  const timeout = setTimeout(() => {
    timedOut = true;
    abortController.abort();
    try {
      zipFile?.close();
    } catch {
      // The ZIP reader was already closed.
    }
  }, timeoutMs);

  try {
    zipFile = await yauzl.openPromise(archivePath, {
      autoClose: false,
      lazyEntries: true,
      validateEntrySizes: true,
      strictFileNames: true,
    });

    let plannedUncompressedBytes = 0;
    let extractedBytes = 0;
    for await (const entry of zipFile.eachEntry()) {
      if (abortController.signal.aborted) throw new ValidationRuntimeError("repository_extract_failed", "archive_extract", { timeoutCategory: "command_timeout", extractionTool: "yauzl", archiveFormat: archive.format, archiveByteSize: archive.byteSize });

      const destinationPath = resolveArchiveEntryPath(extractionPath, entry.fileName);
      if (!destinationPath) throw new ValidationRuntimeError("repository_extract_failed", "archive_extract", { category: "unsafe_archive_entry", extractionTool: "yauzl", archiveFormat: archive.format, archiveByteSize: archive.byteSize });

      if (entry.fileName.endsWith("/")) {
        await mkdir(destinationPath, { recursive: true });
        continue;
      }

      if (!Number.isSafeInteger(entry.uncompressedSize) || entry.uncompressedSize < 0) {
        throw new ValidationRuntimeError("repository_extract_failed", "archive_extract", { category: "invalid_entry_size", extractionTool: "yauzl", archiveFormat: archive.format, archiveByteSize: archive.byteSize });
      }
      plannedUncompressedBytes += entry.uncompressedSize;
      if (plannedUncompressedBytes > PROPOSED_FIX_VALIDATION_LIMITS.maxRepositoryBytes) {
        throw new ValidationRuntimeError("repository_too_large", "repository_too_large", { byteSize: plannedUncompressedBytes, extractionTool: "yauzl", archiveFormat: archive.format });
      }

      await mkdir(dirname(destinationPath), { recursive: true });
      const source = await zipFile.openReadStreamPromise(entry);
      const sizeLimit = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          extractedBytes += chunk.byteLength;
          if (extractedBytes > PROPOSED_FIX_VALIDATION_LIMITS.maxRepositoryBytes) {
            callback(new ValidationRuntimeError("repository_too_large", "repository_too_large", { byteSize: extractedBytes, extractionTool: "yauzl", archiveFormat: archive.format }));
            return;
          }
          callback(null, chunk);
        },
      });
      await pipeline(source, sizeLimit, createWriteStream(destinationPath, { flags: "wx" }), { signal: abortController.signal });
    }
  } catch (error) {
    if (error instanceof ValidationRuntimeError) throw error;
    if (timedOut || abortController.signal.aborted || isTimeoutError(error)) {
      throw new ValidationRuntimeError("repository_extract_failed", "archive_extract", { timeoutCategory: "command_timeout", extractionTool: "yauzl", archiveFormat: archive.format, archiveByteSize: archive.byteSize });
    }
    throw createArchiveExtractionError(error, archive);
  } finally {
    clearTimeout(timeout);
    try {
      zipFile?.close();
    } catch {
      // The ZIP reader was already closed.
    }
  }

  return findExtractedWorkspaceRoot(extractionPath, temporaryRoot);
}

async function validateDownloadedArchive(archivePath: string): Promise<ArchiveMetadata> {
  let archiveStats;
  try {
    archiveStats = await stat(archivePath);
  } catch (error) {
    throw createWorkspacePreparationError(error, "repository_fetch_failed", "archive_download");
  }

  if (!archiveStats.isFile() || archiveStats.size <= 0) {
    throw new ValidationRuntimeError("repository_fetch_failed", "archive_download", {
      category: "archive_file_missing_or_empty",
      archiveExists: archiveStats.isFile(),
      archiveByteSize: archiveStats.size,
    });
  }
  if (archiveStats.size > PROPOSED_FIX_VALIDATION_LIMITS.maxArchiveBytes) {
    throw new ValidationRuntimeError("archive_too_large", "archive_too_large", { byteSize: archiveStats.size, archiveExists: true });
  }

  const signature = Buffer.alloc(4);
  try {
    const archiveHandle = await openFile(archivePath, "r");
    try {
      const { bytesRead } = await archiveHandle.read(signature, 0, signature.length, 0);
      if (bytesRead !== signature.length || !isZipSignature(signature)) {
        throw new ValidationRuntimeError("repository_fetch_failed", "archive_download", {
          category: "invalid_zip_signature",
          archiveExists: true,
          archiveByteSize: archiveStats.size,
          archiveFormat: "unexpected",
        });
      }
    } finally {
      await archiveHandle.close();
    }
  } catch (error) {
    if (error instanceof ValidationRuntimeError) throw error;
    throw createWorkspacePreparationError(error, "repository_fetch_failed", "archive_download");
  }

  return { format: "zip", byteSize: archiveStats.size };
}

function isZipSignature(signature: Buffer) {
  return signature[0] === 0x50
    && signature[1] === 0x4b
    && ((signature[2] === 0x03 && signature[3] === 0x04)
      || (signature[2] === 0x05 && signature[3] === 0x06)
      || (signature[2] === 0x07 && signature[3] === 0x08));
}

function resolveArchiveEntryPath(extractionPath: string, entryName: string) {
  if (yauzl.validateFileName(entryName) || entryName.includes("\0") || entryName.includes("\\")) return null;
  const segments = entryName.split("/");
  const lastIndex = segments.length - 1;
  if (segments.some((segment, index) => (segment === "." || segment === "..") || (!segment && index !== lastIndex))) return null;

  const extractionRoot = resolve(extractionPath);
  const destinationPath = resolve(extractionRoot, ...segments.filter(Boolean));
  return destinationPath.startsWith(`${extractionRoot}${sep}`) ? destinationPath : null;
}

async function findExtractedWorkspaceRoot(extractionPath: string, temporaryRoot: string) {
  let extractedEntries;
  try {
    extractedEntries = await readdir(extractionPath, { withFileTypes: true });
  } catch (error) {
    throw createWorkspacePreparationError(error, "repository_extract_failed", "extracted_root_missing");
  }
  const directories = extractedEntries.filter((entry) => entry.isDirectory());
  if (directories.length !== 1) throw new ValidationRuntimeError("repository_extract_failed", "extracted_root_missing", { category: "invalid_extracted_root", extractionTool: "yauzl" });

  const workspace = join(temporaryRoot, "workspace");
  try {
    await rename(join(extractionPath, directories[0].name), workspace);
  } catch (error) {
    throw createWorkspacePreparationError(error, "repository_extract_failed", "archive_extract");
  }
  return workspace;
}

function createArchiveExtractionError(error: unknown, archive: ArchiveMetadata) {
  const errorCode = getSafeFilesystemErrorCode(error);
  return new ValidationRuntimeError("repository_extract_failed", getWorkspaceStageForError("archive_extract", error), {
    extractionTool: "yauzl",
    archiveFormat: archive.format,
    archiveByteSize: archive.byteSize,
    ...(errorCode ? { filesystemErrorCode: errorCode } : { category: "invalid_or_unreadable_zip" }),
  });
}

async function readBoundedResponseBytes(response: Response, maximumBytes: number) {
  const reader = response.body?.getReader();
  if (!reader) throw new ValidationRuntimeError("repository_fetch_failed", "archive_download", { category: "response_body_unavailable" });

  const chunks: Uint8Array[] = [];
  let bytesRead = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytesRead += value.byteLength;
    if (bytesRead > maximumBytes) {
      await reader.cancel();
      throw new ValidationRuntimeError("archive_too_large", "archive_too_large", { byteSize: bytesRead });
    }
    chunks.push(value);
  }

  const archive = new Uint8Array(bytesRead);
  let offset = 0;
  for (const chunk of chunks) {
    archive.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return archive;
}

async function sanitizeWorkspace(workspace: string): Promise<{ bytes: number; removedEntries: number }> {
  let bytes = 0;
  let removedEntries = 0;

  async function visit(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = join(directory, entry.name);
      if (shouldRemoveWorkspaceEntry(entry.name, entry)) {
        await rm(entryPath, { recursive: true, force: true });
        removedEntries += 1;
        continue;
      }
      if (entry.isDirectory()) {
        await visit(entryPath);
        continue;
      }
      if (!entry.isFile()) {
        await rm(entryPath, { recursive: true, force: true });
        removedEntries += 1;
        continue;
      }
      bytes += (await stat(entryPath)).size;
      if (bytes > PROPOSED_FIX_VALIDATION_LIMITS.maxRepositoryBytes) {
        throw new ValidationRuntimeError("repository_too_large", "repository_too_large", { byteSize: bytes });
      }
    }
  }

  try {
    await visit(workspace);
  } catch (error) {
    if (error instanceof ValidationRuntimeError) throw error;
    throw createWorkspacePreparationError(error, "workspace_error", "sanitize_repository");
  }
  return { bytes, removedEntries };
}

function shouldRemoveWorkspaceEntry(name: string, entry: { isSymbolicLink(): boolean }) {
  const lowerName = name.toLowerCase();
  return entry.isSymbolicLink()
    || lowerName.startsWith(".env")
    || SENSITIVE_FILE_NAMES.has(lowerName)
    || GENERATED_DIRECTORY_NAMES.has(lowerName)
    || lowerName === ".github"
    || lowerName.endsWith(".pem")
    || lowerName.endsWith(".key")
    || lowerName.endsWith(".p12")
    || lowerName.endsWith(".pfx");
}

async function readValidationManifest(workspace: string): Promise<ValidationManifest | null> {
  try {
    const content = await readFile(join(workspace, "package.json"), "utf8");
    const manifest: unknown = JSON.parse(content);
    if (!isRecord(manifest)) {
      logWorkspaceFailure("package_json_missing", { category: "invalid_manifest" });
      return null;
    }
    return {
      scripts: isStringRecord(manifest.scripts) ? manifest.scripts : {},
      packageManager: typeof manifest.packageManager === "string" ? manifest.packageManager.trim() : null,
    };
  } catch (error) {
    logWorkspaceFailure(getWorkspaceStageForError("package_json_missing", error), getSafeFilesystemDetails(error));
    return null;
  }
}

async function detectPackageManager(workspace: string, manifest: ValidationManifest): Promise<PackageManagerDetection> {
  const lockfiles: Array<{ file: string; manager: PackageManager }> = [
    { file: "package-lock.json", manager: "npm" },
    { file: "pnpm-lock.yaml", manager: "pnpm" },
    { file: "yarn.lock", manager: "yarn" },
  ];
  const detected = (await Promise.all(lockfiles.map(async (lockfile) => ({ lockfile, exists: await fileExists(join(workspace, lockfile.file)) })))).flatMap(({ lockfile, exists }) => exists ? [lockfile.manager] : []);
  if (detected.length > 1) return { kind: "ambiguous" };
  if (detected.length === 1) return { kind: "ready", manager: detected[0], mode: "lockfile" };

  return await hasConflictingPackageManagerEvidence(workspace, manifest)
    ? { kind: "missing" }
    : { kind: "ready", manager: "npm", mode: "package_json_fallback" };
}

async function hasConflictingPackageManagerEvidence(workspace: string, manifest: ValidationManifest) {
  if (manifest.packageManager && !/^npm(?:@|$)/i.test(manifest.packageManager)) return true;
  const conflictingEvidence = ["pnpm-workspace.yaml", ".yarn", "bun.lock", "bun.lockb"];
  return (await Promise.all(conflictingEvidence.map((file) => fileExists(join(workspace, file))))).some(Boolean);
}

function getInstallCommand(manager: PackageManager, mode: PackageManagerMode, packageJsonWasUpdated: boolean) {
  if (manager === "npm") {
    if (mode === "package_json_fallback") return { command: "npm", args: ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--no-package-lock"] };
    return packageJsonWasUpdated
      ? { command: "npm", args: ["install", "--ignore-scripts", "--no-audit", "--no-fund"] }
      : { command: "npm", args: ["ci", "--ignore-scripts", "--no-audit", "--no-fund"] };
  }
  if (manager === "pnpm") {
    return packageJsonWasUpdated
      ? { command: "pnpm", args: ["install", "--ignore-scripts", "--no-frozen-lockfile"] }
      : { command: "pnpm", args: ["install", "--frozen-lockfile", "--ignore-scripts"] };
  }
  return packageJsonWasUpdated
    ? { command: "yarn", args: ["install", "--ignore-scripts"] }
    : { command: "yarn", args: ["install", "--frozen-lockfile", "--ignore-scripts"] };
}

async function runValidationChecks(scripts: Record<string, string>, manager: PackageManager, workspace: string, environment: NodeJS.ProcessEnv, deadline: number): Promise<ValidationChecksResult> {
  const checks: ProposedFixValidationResult["checks"] = [];
  const warnings: string[] = [];
  const checkNames = VALIDATION_CHECK_NAMES.slice(0, Math.max(0, PROPOSED_FIX_VALIDATION_LIMITS.maxCommands - 1));

  for (const name of checkNames) {
    if (!scripts[name]) {
      checks.push({ name, status: "skipped", durationMs: 0, summary: "No matching package.json script was found." });
      continue;
    }

    const timeoutMs = getRemainingCommandTimeout(deadline);
    if (timeoutMs <= 0) {
      checks.push({ name, status: "timed_out", durationMs: 0, summary: "Skipped because the total validation time limit was reached." });
      continue;
    }

    const command = getProjectCommand(manager, name);
    const execution = await runLimitedCommand(command.command, command.args, workspace, environment, timeoutMs, name, getCommandTimeoutReason(deadline));
    logCommandCompletion(name, execution);
    if (execution.outputTruncated) warnings.push(getOutputTruncationWarning(name, execution));
    checks.push({
      name,
      status: execution.timedOut ? "timed_out" : isSuccessfulCommand(execution) ? "passed" : "failed",
      durationMs: execution.durationMs,
      summary: getCheckSummary(execution),
    });
  }

  return { checks, warnings };
}

function getProjectCommand(manager: PackageManager, script: CheckName) {
  if (manager === "npm") return { command: "npm", args: ["run", script] };
  if (manager === "pnpm") return { command: "pnpm", args: ["run", script] };
  return { command: "yarn", args: ["run", script] };
}

function createSafeCommandEnvironment(homePath: string, cachePath: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    NODE_ENV: process.env.NODE_ENV ?? "production",
    HOME: homePath,
    TMPDIR: join(homePath, "tmp"),
    CI: "true",
    NO_COLOR: "1",
    npm_config_ignore_scripts: "true",
    npm_config_audit: "false",
    npm_config_fund: "false",
    npm_config_update_notifier: "false",
    npm_config_cache: join(cachePath, "npm"),
    YARN_ENABLE_SCRIPTS: "false",
  };
}

async function runLimitedCommand(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, timeoutMs: number, stage: string, timeoutReason: Extract<CommandTerminationReason, "command_timeout" | "total_validation_timeout">): Promise<CommandResult> {
  const startedAt = Date.now();
  if (timeoutMs <= 0) {
    return {
      exitCode: null,
      signal: null,
      terminationReason: null,
      durationMs: 0,
      timedOut: true,
      outputTruncated: false,
      commandUnavailable: false,
      spawnFailed: false,
      executionError: false,
    };
  }

  return new Promise((resolve) => {
    let retainedOutputBytes = 0;
    let outputTruncated = false;
    const retainedOutputChunks: Buffer[] = [];
    let timedOut = false;
    let commandUnavailable = false;
    let spawnFailed = false;
    let executionError = false;
    let terminationReason: CommandTerminationReason | null = null;
    let settled = false;
    const timeoutRef: { value: ReturnType<typeof setTimeout> | undefined } = { value: undefined };
    let child: ReturnType<typeof spawn>;
    const finish = (exitCode: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      if (timeoutRef.value) clearTimeout(timeoutRef.value);
      resolve({
        exitCode,
        signal,
        terminationReason,
        durationMs: Date.now() - startedAt,
        timedOut,
        outputTruncated,
        commandUnavailable,
        spawnFailed,
        executionError,
      });
    };
    const terminate = (reason: Extract<CommandTerminationReason, "command_timeout" | "total_validation_timeout">) => {
      if (!terminationReason) {
        terminationReason = reason;
        logSafeValidationEvent("command_termination_requested", { stage, reason });
      }
      const terminateProcessTree = (signal: NodeJS.Signals) => {
        if (!child.pid) return;
        try {
          if (process.platform === "win32") child.kill(signal);
          else process.kill(-child.pid, signal);
        } catch {
          // The temporary validation process already exited.
        }
      };
      terminateProcessTree("SIGTERM");
      setTimeout(() => terminateProcessTree("SIGKILL"), 2_000).unref();
    };
    const onOutput = (chunk: Buffer) => {
      const remainingBytes = PROPOSED_FIX_VALIDATION_LIMITS.maxCommandOutputBytes - retainedOutputBytes;
      if (remainingBytes <= 0) {
        outputTruncated = true;
        return;
      }

      const bytesToRetain = Math.min(chunk.byteLength, remainingBytes);
      retainedOutputChunks.push(Buffer.from(chunk.subarray(0, bytesToRetain)));
      retainedOutputBytes += bytesToRetain;
      if (bytesToRetain < chunk.byteLength) outputTruncated = true;
    };
    try {
      child = spawn(command, args, { cwd, env, shell: false, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
    } catch {
      spawnFailed = true;
      executionError = true;
      finish(null, null);
      return;
    }

    child.stdout?.on("data", onOutput);
    child.stderr?.on("data", onOutput);
    child.once("error", (error: NodeJS.ErrnoException) => {
      executionError = true;
      commandUnavailable = error.code === "ENOENT";
      spawnFailed = child.pid === undefined;
      if (spawnFailed) finish(null, null);
    });
    child.once("close", (exitCode, signal) => finish(exitCode, signal));
    timeoutRef.value = setTimeout(() => {
      timedOut = true;
      terminate(timeoutReason);
    }, timeoutMs);
  });
}

function getRemainingCommandTimeout(deadline: number) {
  return Math.max(0, Math.min(PROPOSED_FIX_VALIDATION_LIMITS.maxCommandDurationMs, deadline - Date.now()));
}

function getCommandTimeoutReason(deadline: number): Extract<CommandTerminationReason, "command_timeout" | "total_validation_timeout"> {
  return deadline - Date.now() <= PROPOSED_FIX_VALIDATION_LIMITS.maxCommandDurationMs
    ? "total_validation_timeout"
    : "command_timeout";
}

function getRemainingValidationTimeout(deadline: number, configuredMaximumMs: number) {
  return Math.max(0, Math.min(configuredMaximumMs, deadline - Date.now()));
}

function getInstallFailureSummary(result: CommandResult) {
  if (result.timedOut) return "Dependency installation timed out inside the isolated workspace.";
  if (result.commandUnavailable) return "The required package manager is unavailable in this validation runtime.";
  if (result.spawnFailed) return "Dependency installation could not be started in the isolated workspace.";
  if (result.signal) return `Dependency installation was interrupted by ${result.signal} inside the isolated workspace.`;
  if (result.executionError) return "Dependency installation encountered an execution error in the isolated workspace.";
  return "Dependency installation failed in the isolated workspace.";
}

function getCheckSummary(result: CommandResult) {
  if (result.timedOut) return "Timed out inside the isolated workspace.";
  if (result.commandUnavailable) return "The package manager is unavailable in this validation runtime.";
  if (result.spawnFailed) return "The validation command could not be started in the isolated workspace.";
  if (result.signal) return `Interrupted by ${result.signal} inside the isolated workspace.`;
  if (result.executionError) return "The validation command encountered an execution error in the isolated workspace.";
  return result.exitCode === 0 ? "Automated validation passed." : "The command failed in the isolated workspace.";
}

function isSuccessfulCommand(result: CommandResult) {
  return !result.timedOut
    && !result.commandUnavailable
    && !result.spawnFailed
    && !result.executionError
    && result.signal === null
    && result.exitCode === 0;
}

function getCommandCompletionCategory(result: CommandResult) {
  if (result.timedOut) return "timed_out";
  if (result.spawnFailed) return "spawn_failed";
  if (result.signal) return "signaled";
  if (result.executionError || result.exitCode === null) return "execution_error";
  return result.exitCode === 0 ? "passed" : "failed";
}

function getOutputTruncationWarnings(commands: Array<{ stage: string; result: CommandResult }>) {
  return commands.flatMap(({ stage, result }) => result.outputTruncated ? [getOutputTruncationWarning(stage, result)] : []);
}

function getOutputTruncationWarning(stage: string, result: CommandResult) {
  const stageLabel = stage === "install" ? "Dependency-install" : `${stage.charAt(0).toUpperCase()}${stage.slice(1)}`;
  const completedNormally = !result.timedOut && result.signal === null && result.exitCode !== null;
  return `${stageLabel} output exceeded Sentinel's 24 KiB diagnostic limit and was truncated.${completedNormally ? " The command was allowed to finish normally." : ""}`;
}

function logCommandCompletion(stage: string, result: CommandResult) {
  if (result.signal && !result.terminationReason) {
    logSafeValidationEvent("command_signaled", {
      stage,
      signal: result.signal,
      source: "external_or_child_process",
    });
  }
  logSafeValidationEvent("command_finished", {
    stage,
    exitCode: result.exitCode,
    signal: result.signal,
    terminationReason: result.terminationReason,
    durationMs: result.durationMs,
    timedOut: result.timedOut,
    category: getCommandCompletionCategory(result),
    outputTruncated: result.outputTruncated,
  });
}

function createSkippedChecks(summary: string): ProposedFixValidationResult["checks"] {
  return VALIDATION_CHECK_NAMES.map((name) => ({ name, status: "skipped", durationMs: 0, summary }));
}

function getBaseWarnings(removedEntries: number, packageJsonWasUpdated: boolean, packageManagerMode: PackageManagerMode) {
  const warnings = [
    "Validation ran in an isolated temporary workspace. No repository changes were pushed.",
    "Dependency-install lifecycle scripts were disabled. Explicit typecheck, lint, test, and build scripts may still execute project code inside the isolated workspace.",
  ];
  if (packageManagerMode === "package_json_fallback") warnings.push("No supported lockfile was found. Sentinel used npm dependency resolution from package.json, so installed versions may differ from the repository's normal CI or production environment.");
  if (packageJsonWasUpdated && packageManagerMode === "lockfile") warnings.push("The package manager was allowed to refresh the lockfile only inside the temporary workspace for this proposed dependency update.");
  if (removedEntries > 0) warnings.push("Sensitive, generated, or symlinked repository entries were excluded from the temporary workspace.");
  return warnings;
}

function getInstallSuccessSummary(packageManagerMode: PackageManagerMode) {
  return packageManagerMode === "package_json_fallback"
    ? "Dependencies resolved from package.json with lifecycle scripts disabled; no lockfile was created."
    : "Dependencies installed with lifecycle scripts disabled.";
}

export function createUnableToValidateResult(summary: string): ProposedFixValidationResult {
  return {
    overallStatus: "unable_to_validate",
    baseBranch: null,
    baseCommitSha: null,
    install: { status: "skipped", summary },
    checks: createSkippedChecks("Validation did not run."),
    warnings: ["Validation ran nowhere; no repository files were changed or pushed."],
    partialReasons: [],
  };
}

export function isProposedFixValidationEligibleForDraftPullRequest(result: ProposedFixValidationResult) {
  const hasPassedCheck = result.checks.some((check) => check.status === "passed");
  const checksAreSuccessfulOrSkipped = result.checks.every((check) => check.status === "passed" || check.status === "skipped");
  const baseRequirementsMet = result.install.status === "passed" && hasPassedCheck && checksAreSuccessfulOrSkipped;
  if (result.overallStatus === "passed") return baseRequirementsMet && result.partialReasons.length === 0 && result.checks.every((check) => check.status === "passed");
  if (result.overallStatus !== "partial") return false;

  return baseRequirementsMet
    && result.partialReasons.length > 0
    && result.partialReasons.every((reason) => reason === "skipped_checks" || reason === "no_lockfile_fallback");
}

type PatchApplicationResult = { applied: true } | { applied: false; category: "invalid_source_path" | "source_file_unavailable" | "original_snippet_mismatch" | "invalid_package_json_change" };

async function applyVerifiedProposedFix(workspace: string, proposedFix: ProposedFix, dependencyType: ValidationInput["dependencyType"]): Promise<PatchApplicationResult> {
  if (proposedFix.packageJsonChange.required) {
    const packageJsonPath = join(workspace, "package.json");
    let packageJson: unknown;
    let originalContent: string;
    try {
      originalContent = await readFile(packageJsonPath, "utf8");
      packageJson = JSON.parse(originalContent);
    } catch {
      return { applied: false, category: "invalid_package_json_change" };
    }

    const section = getDependencySection(dependencyType);
    if (!section || !isRecord(packageJson) || !isRecord(packageJson[section]) || packageJson[section][proposedFix.packageJsonChange.dependency] !== proposedFix.packageJsonChange.from) {
      return { applied: false, category: "invalid_package_json_change" };
    }

    packageJson[section][proposedFix.packageJsonChange.dependency] = proposedFix.packageJsonChange.to;
    await writeFile(packageJsonPath, `${JSON.stringify(packageJson, null, getJsonIndentation(originalContent))}\n`, "utf8");
  }

  for (const file of proposedFix.files) {
    const targetPath = resolveWorkspacePath(workspace, file.path);
    if (!targetPath) return { applied: false, category: "invalid_source_path" };

    let source: string;
    try {
      source = await readFile(targetPath, "utf8");
    } catch {
      return { applied: false, category: "source_file_unavailable" };
    }

    const firstMatch = source.indexOf(file.originalSnippet);
    if (firstMatch === -1 || firstMatch !== source.lastIndexOf(file.originalSnippet)) {
      return { applied: false, category: "original_snippet_mismatch" };
    }
    await writeFile(targetPath, `${source.slice(0, firstMatch)}${file.proposedSnippet}${source.slice(firstMatch + file.originalSnippet.length)}`, "utf8");
  }

  return { applied: true };
}

function getDependencySection(dependencyType: ValidationInput["dependencyType"]) {
  if (dependencyType === "dependency") return "dependencies";
  if (dependencyType === "devDependency") return "devDependencies";
  if (dependencyType === "peerDependency") return "peerDependencies";
  return "optionalDependencies";
}

function resolveWorkspacePath(workspace: string, requestedPath: string) {
  if (!requestedPath || requestedPath.startsWith("/") || requestedPath.includes("\\")) return null;
  const rootPath = resolve(workspace);
  const targetPath = resolve(rootPath, ...requestedPath.split("/"));
  return targetPath.startsWith(`${rootPath}${sep}`) ? targetPath : null;
}

function getJsonIndentation(content: string) {
  const match = content.match(/\n([ \t]+)"/);
  return match?.[1] ?? "  ";
}

function addCleanupWarning(result: ProposedFixValidationResult): ProposedFixValidationResult {
  return {
    ...result,
    overallStatus: result.overallStatus === "passed" ? "partial" : result.overallStatus,
    warnings: [...result.warnings, "Temporary workspace cleanup could not be fully confirmed."],
    partialReasons: [...new Set([...result.partialReasons, "cleanup_unconfirmed" as const])],
  };
}

function addValidationBase(result: ProposedFixValidationResult, input: Pick<ValidationInput, "defaultBranch" | "baseCommitSha">): ProposedFixValidationResult {
  return { ...result, baseBranch: input.defaultBranch, baseCommitSha: input.baseCommitSha };
}

function isSafeGitCommitSha(value: string) {
  return /^[a-f\d]{40,64}$/i.test(value);
}

function githubHeaders(accessToken: string) {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${accessToken}`,
    "User-Agent": "Sentinel",
    "X-GitHub-Api-Version": "2026-03-10",
  };
}

async function fileExists(path: string) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

class ValidationRuntimeError extends Error {
  constructor(
    readonly category: string,
    readonly workspaceStage?: WorkspacePreparationStage,
    readonly details: SafeWorkspaceFailureDetails = {},
  ) {
    super(category);
  }
}

function getValidationFailureCategory(error: unknown) {
  if (error instanceof ValidationRuntimeError) return error.category;
  if (error instanceof DOMException && (error.name === "TimeoutError" || error.name === "AbortError")) return "timeout";
  return "workspace_error";
}

function createWorkspacePreparationError(error: unknown, category: string, requestedStage: WorkspacePreparationStage) {
  if (error instanceof ValidationRuntimeError) return error;
  const details = getSafeWorkspaceErrorDetails(error);
  return new ValidationRuntimeError(category, getWorkspaceStageForError(requestedStage, error), details);
}

function getWorkspaceFailureDiagnostic(error: unknown, category: string): { stage: WorkspacePreparationStage; details: SafeWorkspaceFailureDetails } {
  if (error instanceof ValidationRuntimeError) {
    return {
      stage: error.workspaceStage ?? getDefaultWorkspaceStage(category),
      details: error.details,
    };
  }
  return {
    stage: getWorkspaceStageForError(getDefaultWorkspaceStage(category), error),
    details: getSafeWorkspaceErrorDetails(error),
  };
}

function getDefaultWorkspaceStage(category: string): WorkspacePreparationStage {
  if (category === "repository_fetch_failed" || category === "timeout") return "archive_download";
  if (category === "archive_too_large") return "archive_too_large";
  if (category === "repository_extract_failed" || category === "runtime_unavailable") return "archive_extract";
  if (category === "repository_too_large") return "repository_too_large";
  return "unexpected_workspace_error";
}

function getWorkspaceStageForError(requestedStage: WorkspacePreparationStage, error: unknown): WorkspacePreparationStage {
  const errorCode = getSafeFilesystemErrorCode(error);
  return errorCode === "EACCES" || errorCode === "EPERM" ? "filesystem_permission" : requestedStage;
}

function getSafeWorkspaceErrorDetails(error: unknown): SafeWorkspaceFailureDetails {
  const errorCode = getSafeFilesystemErrorCode(error);
  if (errorCode) return { filesystemErrorCode: errorCode };
  if (isTimeoutError(error)) return { timeoutCategory: "timeout" };
  return { category: "workspace_error" };
}

function getSafeFilesystemDetails(error: unknown): SafeWorkspaceFailureDetails {
  const details = getSafeWorkspaceErrorDetails(error);
  return "filesystemErrorCode" in details || "timeoutCategory" in details ? details : { category: "not_found_or_invalid" };
}

function getSafeFilesystemErrorCode(error: unknown) {
  if (typeof error !== "object" || error === null || !("code" in error) || typeof error.code !== "string") return null;
  return new Set(["EACCES", "EPERM", "ENOENT", "ENOSPC", "EIO", "EROFS"]).has(error.code) ? error.code : null;
}

function getHttpStatusCategory(status: number) {
  if (status === 429) return "rate_limited";
  if (status >= 500) return "server_error";
  return "client_error";
}

function isTimeoutError(error: unknown) {
  return error instanceof DOMException && (error.name === "TimeoutError" || error.name === "AbortError");
}

function logWorkspaceFailure(stage: WorkspacePreparationStage, details: SafeWorkspaceFailureDetails = {}) {
  console.error("[sentinel:validation] workspace_failed", { stage, ...details });
}

function logSafeValidationEvent(event: string, details: Record<string, string | number | boolean | null>) {
  console.error("[sentinel:fix-validation]", event, details);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((item) => typeof item === "string");
}
