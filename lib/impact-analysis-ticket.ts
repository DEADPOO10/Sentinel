import "server-only";

import { createHash, createHmac, timingSafeEqual } from "node:crypto";

const TICKET_LIFETIME_MS = 15 * 60 * 1_000;

export type ImpactAnalysisSnapshot = {
  summary: string;
  potentialImpact: string;
  riskExplanation: string;
  recommendedNextStep: string;
  confidence: number;
};

type TicketPayload = {
  version: 1;
  userId: string;
  owner: string;
  repository: string;
  dependencyName: string;
  dependencyType: string;
  expiresAt: number;
  analysisHash: string;
};

export type ProposedFixValidationSnapshot = {
  title: string;
  summary: string;
  confidence: number;
  files: Array<{
    path: string;
    reason: string;
    originalSnippet: string;
    proposedSnippet: string;
  }>;
  packageJsonChange: {
    required: boolean;
    dependency: string;
    from: string;
    to: string;
  };
  validationSteps: string[];
  warnings: string[];
};

type ProposedFixTicketPayload = {
  version: 1;
  userId: string;
  owner: string;
  repository: string;
  dependencyName: string;
  dependencyType: string;
  expiresAt: number;
  proposedFixHash: string;
};

export function createImpactAnalysisTicket(input: Omit<TicketPayload, "version" | "expiresAt" | "analysisHash"> & { analysis: ImpactAnalysisSnapshot }) {
  const secret = getTicketSecret();
  if (!secret) return null;

  const payload: TicketPayload = {
    version: 1,
    userId: input.userId,
    owner: input.owner,
    repository: input.repository,
    dependencyName: input.dependencyName,
    dependencyType: input.dependencyType,
    expiresAt: Date.now() + TICKET_LIFETIME_MS,
    analysisHash: getAnalysisHash(input.analysis),
  };
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${encodedPayload}.${sign(encodedPayload, secret)}`;
}

export function verifyImpactAnalysisTicket(ticket: string, input: Omit<TicketPayload, "version" | "expiresAt" | "analysisHash"> & { analysis: ImpactAnalysisSnapshot }) {
  const secret = getTicketSecret();
  if (!secret || ticket.length > 4_096) return false;

  const [encodedPayload, signature, ...extraParts] = ticket.split(".");
  if (!encodedPayload || !signature || extraParts.length > 0 || !isValidSignature(signature, sign(encodedPayload, secret))) return false;

  try {
    const payload: unknown = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8"));
    if (!isTicketPayload(payload) || payload.expiresAt < Date.now()) return false;

    return payload.userId === input.userId
      && payload.owner === input.owner
      && payload.repository === input.repository
      && payload.dependencyName === input.dependencyName
      && payload.dependencyType === input.dependencyType
      && payload.analysisHash === getAnalysisHash(input.analysis);
  } catch {
    return false;
  }
}

export function getImpactAnalysisSnapshot(value: unknown): ImpactAnalysisSnapshot | null {
  if (!isRecord(value) || !isSafeText(value.summary) || !isSafeText(value.potentialImpact) || !isSafeText(value.riskExplanation) || !isSafeText(value.recommendedNextStep) || !isConfidence(value.confidence)) return null;

  return {
    summary: value.summary,
    potentialImpact: value.potentialImpact,
    riskExplanation: value.riskExplanation,
    recommendedNextStep: value.recommendedNextStep,
    confidence: value.confidence,
  };
}

export function createProposedFixValidationTicket(input: Omit<ProposedFixTicketPayload, "version" | "expiresAt" | "proposedFixHash"> & { proposedFix: ProposedFixValidationSnapshot }) {
  const secret = getTicketSecret();
  if (!secret) return null;

  const payload: ProposedFixTicketPayload = {
    version: 1,
    userId: input.userId,
    owner: input.owner,
    repository: input.repository,
    dependencyName: input.dependencyName,
    dependencyType: input.dependencyType,
    expiresAt: Date.now() + TICKET_LIFETIME_MS,
    proposedFixHash: getProposedFixHash(input.proposedFix),
  };
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${encodedPayload}.${sign(encodedPayload, secret)}`;
}

export function verifyProposedFixValidationTicket(ticket: string, input: Omit<ProposedFixTicketPayload, "version" | "expiresAt" | "proposedFixHash"> & { proposedFix: ProposedFixValidationSnapshot }) {
  const secret = getTicketSecret();
  if (!secret || ticket.length > 4_096) return false;

  const [encodedPayload, signature, ...extraParts] = ticket.split(".");
  if (!encodedPayload || !signature || extraParts.length > 0 || !isValidSignature(signature, sign(encodedPayload, secret))) return false;

  try {
    const payload: unknown = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8"));
    if (!isProposedFixTicketPayload(payload) || payload.expiresAt < Date.now()) return false;

    return payload.userId === input.userId
      && payload.owner === input.owner
      && payload.repository === input.repository
      && payload.dependencyName === input.dependencyName
      && payload.dependencyType === input.dependencyType
      && payload.proposedFixHash === getProposedFixHash(input.proposedFix);
  } catch {
    return false;
  }
}

export function getProposedFixValidationSnapshot(value: unknown): ProposedFixValidationSnapshot | null {
  if (!isRecord(value) || !isSafeText(value.title) || !isSafeText(value.summary) || !isConfidence(value.confidence) || !Array.isArray(value.files) || !isPackageJsonChange(value.packageJsonChange) || !isSafeTextList(value.validationSteps, 8, 400) || !isSafeTextList(value.warnings, 8, 400)) return null;

  const files = value.files.flatMap((file) => {
    if (!isRecord(file) || !isSafeText(file.path, 1_000) || !isSafeText(file.reason) || !isSafeText(file.originalSnippet, 2_000) || !isSafeText(file.proposedSnippet, 2_000)) return [];
    return [{ path: file.path, reason: file.reason, originalSnippet: file.originalSnippet, proposedSnippet: file.proposedSnippet }];
  });
  if (files.length !== value.files.length || files.length > 3) return null;

  return {
    title: value.title,
    summary: value.summary,
    confidence: value.confidence,
    files,
    packageJsonChange: value.packageJsonChange,
    validationSteps: value.validationSteps,
    warnings: value.warnings,
  };
}

function getAnalysisHash(analysis: ImpactAnalysisSnapshot) {
  return createHash("sha256").update(JSON.stringify({
    summary: analysis.summary,
    potentialImpact: analysis.potentialImpact,
    riskExplanation: analysis.riskExplanation,
    recommendedNextStep: analysis.recommendedNextStep,
    confidence: analysis.confidence,
  })).digest("base64url");
}

function getProposedFixHash(proposedFix: ProposedFixValidationSnapshot) {
  return createHash("sha256").update(JSON.stringify(proposedFix)).digest("base64url");
}

function getTicketSecret() {
  return process.env.AUTH_SECRET ?? process.env.NEXTAUTH_SECRET ?? null;
}

function sign(value: string, secret: string) {
  return createHmac("sha256", secret).update(value).digest("base64url");
}

function isValidSignature(actual: string, expected: string) {
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

function isTicketPayload(value: unknown): value is TicketPayload {
  return isRecord(value)
    && value.version === 1
    && typeof value.userId === "string"
    && typeof value.owner === "string"
    && typeof value.repository === "string"
    && typeof value.dependencyName === "string"
    && typeof value.dependencyType === "string"
    && typeof value.expiresAt === "number"
    && Number.isFinite(value.expiresAt)
    && typeof value.analysisHash === "string";
}

function isProposedFixTicketPayload(value: unknown): value is ProposedFixTicketPayload {
  return isRecord(value)
    && value.version === 1
    && typeof value.userId === "string"
    && typeof value.owner === "string"
    && typeof value.repository === "string"
    && typeof value.dependencyName === "string"
    && typeof value.dependencyType === "string"
    && typeof value.expiresAt === "number"
    && Number.isFinite(value.expiresAt)
    && typeof value.proposedFixHash === "string";
}

function isPackageJsonChange(value: unknown): value is ProposedFixValidationSnapshot["packageJsonChange"] {
  return isRecord(value)
    && typeof value.required === "boolean"
    && isSafeText(value.dependency, 214)
    && isSafeText(value.from, 1_000)
    && isSafeText(value.to, 1_000);
}

function isSafeTextList(value: unknown, maximumItems: number, maximumLength: number): value is string[] {
  return Array.isArray(value) && value.length <= maximumItems && value.every((item) => isSafeText(item, maximumLength));
}

function isSafeText(value: unknown, maximumLength = 1_000): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maximumLength;
}

function isConfidence(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
