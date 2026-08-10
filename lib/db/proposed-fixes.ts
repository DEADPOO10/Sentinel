import "server-only";

import { getCurrentGitHubUserId, getPersistedFindingIdentity, resolveLatestFindingForCurrentUser, type FindingResolutionStage, type PersistedFindingIdentity, type PersistedFindingIdentityInput } from "@/lib/db/finding-resolution";
import { getPrismaClient } from "@/lib/db/prisma";
import type { ProposedFix } from "@/lib/openai/proposed-fix";

const MAX_SOURCE_CHANGES = 3;
const MAX_SNIPPET_CHARACTERS = 2_000;
const MAX_TEXT_LIST_ITEMS = 8;
const MAX_TEXT_LIST_ITEM_CHARACTERS = 400;

type ProposedFixPersistenceStage = FindingResolutionStage | "proposed_fix_resolution" | "proposed_fix_upsert";
type ProposedFixPersistenceUnavailableCategory = "invalid_input" | "repository_not_connected" | "latest_scan_unavailable" | "latest_scan_mismatch" | "finding_not_found_or_changed" | "proposed_fix_not_found_or_changed" | "database_error";

export type ProposedFixPersistenceInput = PersistedFindingIdentityInput & {
  proposal: ProposedFix;
};

export type ProposedFixPersistenceResult =
  | { kind: "persisted"; findingId: string }
  | { kind: "unavailable"; category: ProposedFixPersistenceUnavailableCategory };

export type PersistedProposedFixResolution =
  | { kind: "resolved"; proposedFixId: string }
  | { kind: "unavailable"; stage: ProposedFixPersistenceStage; category: ProposedFixPersistenceUnavailableCategory };

export type SavedProposedFix = {
  status: "proposed" | "insufficient_context";
  confidence: number | null;
  summary: string;
  packageJsonChange: {
    required: boolean;
    dependency: string;
    from: string;
    to: string;
  } | null;
  sourceChanges: Array<{
    path: string;
    reason: string;
    originalSnippet: string;
    proposedSnippet: string;
  }>;
  validationSteps: string[];
  warnings: string[];
  createdAt: Date;
};

/**
 * Persists a verified proposal as the one current snapshot for a current, user-owned finding.
 * The proposal is never read from a client request: it has already passed the OpenAI response
 * verifier in the server action before this helper is called.
 */
export async function persistProposedFixForFinding(input: ProposedFixPersistenceInput): Promise<ProposedFixPersistenceResult> {
  const data = getPersistenceData(input);
  if (!data) return logUnavailable("finding_resolution", "invalid_input");

  let stage: ProposedFixPersistenceStage = "membership_verification";
  try {
    const githubUserId = await getCurrentGitHubUserId();
    if (!githubUserId) return logUnavailable("membership_verification", "repository_not_connected");

    const client = getPrismaClient();
    const finding = await resolveLatestFindingForCurrentUser(client, githubUserId, data.identity, (nextStage) => {
      stage = nextStage;
    });
    if ("kind" in finding) return logUnavailable(stage, finding.category);

    stage = "proposed_fix_upsert";
    const saved = await client.proposedFix.upsert({
      where: { findingId: finding.findingId },
      create: {
        findingId: finding.findingId,
        status: "PROPOSED",
        confidence: data.proposal.confidence,
        summary: data.proposal.summary,
        packageJsonChangeJson: data.proposal.packageJsonChange,
        sourceChangesJson: data.proposal.sourceChanges,
        validationStepsJson: data.proposal.validationSteps,
        warningsJson: data.proposal.warnings,
        createdAt: new Date(),
      },
      update: {
        status: "PROPOSED",
        confidence: data.proposal.confidence,
        summary: data.proposal.summary,
        packageJsonChangeJson: data.proposal.packageJsonChange,
        sourceChangesJson: data.proposal.sourceChanges,
        validationStepsJson: data.proposal.validationSteps,
        warningsJson: data.proposal.warnings,
        createdAt: new Date(),
      },
      select: { findingId: true },
    });

    console.info("[sentinel:proposed-fix-persistence] upsert_completed", { stage });
    return { kind: "persisted", findingId: saved.findingId };
  } catch (error) {
    logPersistenceFailure(stage, error);
    return { kind: "unavailable", category: "database_error" };
  }
}

/**
 * Resolves the current persisted proposal only when it exactly matches the
 * verified proposal supplied by the signed validation flow.
 */
export async function resolvePersistedProposedFixForValidation(input: ProposedFixPersistenceInput): Promise<PersistedProposedFixResolution> {
  const data = getPersistenceData(input);
  if (!data) return { kind: "unavailable", stage: "finding_resolution", category: "invalid_input" };

  let stage: ProposedFixPersistenceStage = "membership_verification";
  const githubUserId = await getCurrentGitHubUserId();
  if (!githubUserId) return { kind: "unavailable", stage, category: "repository_not_connected" };

  const client = getPrismaClient();
  const finding = await resolveLatestFindingForCurrentUser(client, githubUserId, data.identity, (nextStage) => {
    stage = nextStage;
  });
  if ("kind" in finding) return { kind: "unavailable", stage, category: finding.category };

  stage = "proposed_fix_resolution";
  const proposedFix = await client.proposedFix.findUnique({
    where: { findingId: finding.findingId },
    select: {
      id: true,
      status: true,
      confidence: true,
      summary: true,
      packageJsonChangeJson: true,
      sourceChangesJson: true,
      validationStepsJson: true,
      warningsJson: true,
    },
  });
  if (!proposedFix || !matchesPersistedProposal(proposedFix, data.proposal)) {
    return { kind: "unavailable", stage, category: "proposed_fix_not_found_or_changed" };
  }

  return { kind: "resolved", proposedFixId: proposedFix.id };
}

/** Reads a current proposal only after re-verifying user ownership and the latest matching finding. */
export async function getProposedFixForFinding(input: Omit<ProposedFixPersistenceInput, "proposal">): Promise<SavedProposedFix | null> {
  const identity = getPersistedFindingIdentity(input);
  if (!identity) return null;

  const githubUserId = await getCurrentGitHubUserId();
  if (!githubUserId) return null;

  let stage: ProposedFixPersistenceStage = "membership_verification";
  try {
    const client = getPrismaClient();
    const finding = await resolveLatestFindingForCurrentUser(client, githubUserId, identity, (nextStage) => {
      stage = nextStage;
    });
    if ("kind" in finding) return null;

    stage = "proposed_fix_upsert";
    const proposedFix = await client.proposedFix.findUnique({
      where: { findingId: finding.findingId },
      select: {
        status: true,
        confidence: true,
        summary: true,
        packageJsonChangeJson: true,
        sourceChangesJson: true,
        validationStepsJson: true,
        warningsJson: true,
        createdAt: true,
      },
    });
    return proposedFix ? toSavedProposedFix(proposedFix) : null;
  } catch (error) {
    logPersistenceFailure(stage, error);
    return null;
  }
}

type PersistenceData = {
  identity: PersistedFindingIdentity;
  proposal: {
    confidence: number;
    summary: string;
    packageJsonChange: {
      required: boolean;
      dependency: string;
      from: string;
      to: string;
    };
    sourceChanges: SavedProposedFix["sourceChanges"];
    validationSteps: string[];
    warnings: string[];
  };
};

function getPersistenceData(input: ProposedFixPersistenceInput): PersistenceData | null {
  const identity = getPersistedFindingIdentity(input);
  const title = getSafeText(input.proposal.title, 160);
  const summary = getSafeText(input.proposal.summary, 1_000);
  const confidence = getSafeConfidence(input.proposal.confidence);
  const sourceChanges = getSafeSourceChanges(input.proposal.files);
  const validationSteps = getSafeTextList(input.proposal.validationSteps);
  const warnings = getSafeTextList(input.proposal.warnings);
  if (!identity || !title || !summary || confidence === null || !sourceChanges || !validationSteps || !warnings) return null;

  const packageJsonChange = input.proposal.packageJsonChange;
  if (!isRecord(packageJsonChange) || typeof packageJsonChange.required !== "boolean" || packageJsonChange.dependency !== identity.dependency.packageName || packageJsonChange.from !== identity.dependency.declaredVersion || packageJsonChange.to !== identity.dependency.latestVersion) return null;
  if (sourceChanges.length === 0 && !packageJsonChange.required) return null;

  return {
    identity,
    proposal: {
      confidence,
      summary,
      packageJsonChange: {
        required: packageJsonChange.required,
        dependency: identity.dependency.packageName,
        from: identity.dependency.declaredVersion,
        to: identity.dependency.latestVersion,
      },
      sourceChanges,
      validationSteps,
      warnings,
    },
  };
}

function toSavedProposedFix(value: {
  status: "PROPOSED" | "INSUFFICIENT_CONTEXT";
  confidence: number | null;
  summary: string;
  packageJsonChangeJson: unknown;
  sourceChangesJson: unknown;
  validationStepsJson: unknown;
  warningsJson: unknown;
  createdAt: Date;
}): SavedProposedFix | null {
  const summary = getSafeText(value.summary, 1_000);
  const packageJsonChange = getSavedPackageJsonChange(value.packageJsonChangeJson);
  const sourceChanges = getSafeSourceChanges(value.sourceChangesJson);
  const validationSteps = getSafeTextList(value.validationStepsJson);
  const warnings = getSafeTextList(value.warningsJson);
  if (!summary || !packageJsonChange || !sourceChanges || !validationSteps || !warnings) return null;

  return {
    status: value.status === "PROPOSED" ? "proposed" : "insufficient_context",
    confidence: value.confidence === null ? null : getSafeConfidence(value.confidence),
    summary,
    packageJsonChange,
    sourceChanges,
    validationSteps,
    warnings,
    createdAt: value.createdAt,
  };
}

function getSavedPackageJsonChange(value: unknown): SavedProposedFix["packageJsonChange"] {
  if (!isRecord(value) || typeof value.required !== "boolean") return null;
  const dependency = getSafeText(value.dependency, 214);
  const from = getSafeText(value.from, 256);
  const to = getSafeText(value.to, 64);
  return dependency && from && to ? { required: value.required, dependency, from, to } : null;
}

function matchesPersistedProposal(value: {
  status: "PROPOSED" | "INSUFFICIENT_CONTEXT";
  confidence: number | null;
  summary: string;
  packageJsonChangeJson: unknown;
  sourceChangesJson: unknown;
  validationStepsJson: unknown;
  warningsJson: unknown;
}, proposal: PersistenceData["proposal"]) {
  return value.status === "PROPOSED"
    && value.confidence === proposal.confidence
    && value.summary === proposal.summary
    && isSameJsonValue(value.packageJsonChangeJson, proposal.packageJsonChange)
    && isSameJsonValue(value.sourceChangesJson, proposal.sourceChanges)
    && isSameJsonValue(value.validationStepsJson, proposal.validationSteps)
    && isSameJsonValue(value.warningsJson, proposal.warnings);
}

function isSameJsonValue(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((item, index) => isSameJsonValue(item, right[index]));
  }
  if (!isRecord(left) || !isRecord(right)) return false;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => key === rightKeys[index] && isSameJsonValue(left[key], right[key]));
}

function getSafeSourceChanges(value: unknown): SavedProposedFix["sourceChanges"] | null {
  if (!Array.isArray(value) || value.length > MAX_SOURCE_CHANGES) return null;
  const paths = new Set<string>();
  const sourceChanges: SavedProposedFix["sourceChanges"] = [];
  for (const item of value) {
    if (!isRecord(item)) return null;
    const path = getSafeRelativePath(item.path);
    const reason = getSafeText(item.reason, 500);
    const originalSnippet = getSafeSnippet(item.originalSnippet);
    const proposedSnippet = getSafeSnippet(item.proposedSnippet);
    if (!path || !reason || !originalSnippet || !proposedSnippet || paths.has(path)) return null;
    paths.add(path);
    sourceChanges.push({ path, reason, originalSnippet, proposedSnippet });
  }
  return sourceChanges;
}

function getSafeTextList(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > MAX_TEXT_LIST_ITEMS) return null;
  const items = value.map((item) => getSafeText(item, MAX_TEXT_LIST_ITEM_CHARACTERS));
  return items.every((item): item is string => item !== null) ? items : null;
}

function getSafeRelativePath(value: unknown) {
  if (typeof value !== "string" || value.length === 0 || value.length > 512 || value.startsWith("/") || value.includes("\\") || value.split("/").some((part) => part.length === 0 || part === "." || part === "..") || /[\u0000-\u001F\u007F]/.test(value)) return null;
  return value;
}

function getSafeSnippet(value: unknown) {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_SNIPPET_CHARACTERS && !value.includes("\u0000") ? value : null;
}

function getSafeText(value: unknown, maximumLength: number) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= maximumLength && !/[\u0000-\u001F\u007F]/.test(normalized) ? normalized : null;
}

function getSafeConfidence(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 100 ? value : null;
}

function logUnavailable(stage: ProposedFixPersistenceStage, category: ProposedFixPersistenceUnavailableCategory): ProposedFixPersistenceResult {
  console.info("[sentinel:proposed-fix-persistence] persistence_unavailable", { stage, category });
  return { kind: "unavailable", category };
}

function logPersistenceFailure(stage: ProposedFixPersistenceStage, error: unknown) {
  const record = isRecord(error) ? error : null;
  const meta = record && isRecord(record.meta) ? record.meta : null;
  console.error("[sentinel:proposed-fix-persistence] persistence_failed", {
    stage,
    errorName: getSafeErrorName(error),
    prismaCode: getSafePrismaCode(record?.code),
    model: getSafeModelName(meta?.modelName),
    target: getSafeConstraintTarget(meta?.target),
    category: getSafeErrorCategory(record?.code),
  });
}

function getSafeErrorName(error: unknown) {
  return error instanceof Error && /^[A-Za-z][A-Za-z\d]{0,96}$/.test(error.name) ? error.name : "unknown_error";
}

function getSafePrismaCode(value: unknown) {
  return typeof value === "string" && /^(?:P\d{4}|\d{5})$/.test(value) ? value : null;
}

function getSafeModelName(value: unknown) {
  return value === "UserRepository" || value === "Scan" || value === "Finding" || value === "ProposedFix" ? value : null;
}

function getSafeConstraintTarget(value: unknown) {
  if (!Array.isArray(value)) return null;
  const target = value.filter((item): item is string => typeof item === "string" && /^[A-Za-z][A-Za-z\d_]{0,100}$/.test(item)).slice(0, 3);
  return target.length > 0 ? target.join(",") : null;
}

function getSafeErrorCategory(value: unknown) {
  if (value === "P2002" || value === "23505") return "unique_constraint";
  if (value === "P2003" || value === "23503") return "foreign_key_constraint";
  if (value === "P2028") return "transaction_closed";
  if (value === "P2034" || value === "40001") return "transaction_conflict";
  if (value === "P1001" || value === "P1002" || value === "P1008") return "database_connection_or_timeout";
  return "database_or_request_error";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
