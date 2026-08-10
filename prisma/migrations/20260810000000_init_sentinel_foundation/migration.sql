-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "RepositoryVisibility" AS ENUM ('PUBLIC', 'PRIVATE', 'INTERNAL');

-- CreateEnum
CREATE TYPE "ScanStatus" AS ENUM ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "DependencyType" AS ENUM ('DEPENDENCY', 'DEV_DEPENDENCY', 'PEER_DEPENDENCY', 'OPTIONAL_DEPENDENCY');

-- CreateEnum
CREATE TYPE "FindingStatus" AS ENUM ('UP_TO_DATE', 'UPDATE_AVAILABLE', 'AHEAD_OF_NPM_LATEST', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "ChangeType" AS ENUM ('MAJOR', 'MINOR', 'PATCH');

-- CreateEnum
CREATE TYPE "RiskLevel" AS ENUM ('LOW', 'MEDIUM', 'HIGH');

-- CreateEnum
CREATE TYPE "ProposedFixStatus" AS ENUM ('PROPOSED', 'INSUFFICIENT_CONTEXT');

-- CreateEnum
CREATE TYPE "ValidationOverallStatus" AS ENUM ('PASSED', 'FAILED', 'PARTIAL', 'UNABLE_TO_VALIDATE');

-- CreateEnum
CREATE TYPE "ValidationStageStatus" AS ENUM ('PASSED', 'FAILED', 'SKIPPED', 'TIMED_OUT');

-- CreateEnum
CREATE TYPE "PullRequestStatus" AS ENUM ('DRAFT', 'OPEN', 'CLOSED', 'MERGED');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "githubUserId" TEXT NOT NULL,
    "githubLogin" TEXT NOT NULL,
    "name" TEXT,
    "email" TEXT,
    "avatarUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Repository" (
    "id" TEXT NOT NULL,
    "githubRepositoryId" TEXT NOT NULL,
    "owner" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "visibility" "RepositoryVisibility" NOT NULL,
    "defaultBranch" TEXT NOT NULL,
    "language" TEXT,
    "githubUrl" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Repository_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserRepository" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "repositoryId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserRepository_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Scan" (
    "id" TEXT NOT NULL,
    "repositoryId" TEXT NOT NULL,
    "status" "ScanStatus" NOT NULL DEFAULT 'PENDING',
    "baseCommitSha" TEXT,
    "dependencyCount" INTEGER NOT NULL DEFAULT 0,
    "updatesAvailable" INTEGER NOT NULL DEFAULT 0,
    "highRiskCount" INTEGER NOT NULL DEFAULT 0,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Scan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Finding" (
    "id" TEXT NOT NULL,
    "scanId" TEXT NOT NULL,
    "packageName" TEXT NOT NULL,
    "dependencyType" "DependencyType" NOT NULL,
    "declaredVersion" TEXT NOT NULL,
    "latestVersion" TEXT,
    "changeType" "ChangeType",
    "risk" "RiskLevel",
    "status" "FindingStatus" NOT NULL,
    "releaseEvidenceAvailable" BOOLEAN NOT NULL DEFAULT false,
    "repositoryUsageCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Finding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ImpactAnalysis" (
    "id" TEXT NOT NULL,
    "findingId" TEXT NOT NULL,
    "risk" "RiskLevel" NOT NULL,
    "confidence" INTEGER NOT NULL,
    "summary" TEXT NOT NULL,
    "potentialImpact" TEXT NOT NULL,
    "riskExplanation" TEXT NOT NULL,
    "recommendation" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ImpactAnalysis_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProposedFix" (
    "id" TEXT NOT NULL,
    "findingId" TEXT NOT NULL,
    "status" "ProposedFixStatus" NOT NULL,
    "confidence" INTEGER,
    "summary" TEXT NOT NULL,
    "packageJsonChangeJson" JSONB NOT NULL,
    "sourceChangesJson" JSONB NOT NULL,
    "validationStepsJson" JSONB NOT NULL,
    "warningsJson" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProposedFix_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ValidationRun" (
    "id" TEXT NOT NULL,
    "proposedFixId" TEXT NOT NULL,
    "overallStatus" "ValidationOverallStatus" NOT NULL,
    "baseCommitSha" TEXT NOT NULL,
    "installStatus" "ValidationStageStatus" NOT NULL,
    "typecheckStatus" "ValidationStageStatus",
    "lintStatus" "ValidationStageStatus",
    "testStatus" "ValidationStageStatus",
    "buildStatus" "ValidationStageStatus",
    "warningsJson" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ValidationRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PullRequest" (
    "id" TEXT NOT NULL,
    "proposedFixId" TEXT NOT NULL,
    "githubPrNumber" INTEGER NOT NULL,
    "githubPrUrl" TEXT NOT NULL,
    "branchName" TEXT NOT NULL,
    "baseBranch" TEXT NOT NULL,
    "commitSha" TEXT NOT NULL,
    "draft" BOOLEAN NOT NULL DEFAULT true,
    "status" "PullRequestStatus" NOT NULL DEFAULT 'DRAFT',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PullRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_githubUserId_key" ON "User"("githubUserId");

-- CreateIndex
CREATE INDEX "User_githubLogin_idx" ON "User"("githubLogin");

-- CreateIndex
CREATE UNIQUE INDEX "Repository_githubRepositoryId_key" ON "Repository"("githubRepositoryId");

-- CreateIndex
CREATE INDEX "Repository_fullName_idx" ON "Repository"("fullName");

-- CreateIndex
CREATE INDEX "Repository_owner_name_idx" ON "Repository"("owner", "name");

-- CreateIndex
CREATE INDEX "UserRepository_repositoryId_idx" ON "UserRepository"("repositoryId");

-- CreateIndex
CREATE UNIQUE INDEX "UserRepository_userId_repositoryId_key" ON "UserRepository"("userId", "repositoryId");

-- CreateIndex
CREATE INDEX "Scan_repositoryId_createdAt_idx" ON "Scan"("repositoryId", "createdAt");

-- CreateIndex
CREATE INDEX "Scan_status_createdAt_idx" ON "Scan"("status", "createdAt");

-- CreateIndex
CREATE INDEX "Finding_status_idx" ON "Finding"("status");

-- CreateIndex
CREATE UNIQUE INDEX "Finding_scanId_packageName_dependencyType_key" ON "Finding"("scanId", "packageName", "dependencyType");

-- CreateIndex
CREATE UNIQUE INDEX "ImpactAnalysis_findingId_key" ON "ImpactAnalysis"("findingId");

-- CreateIndex
CREATE INDEX "ProposedFix_findingId_createdAt_idx" ON "ProposedFix"("findingId", "createdAt");

-- CreateIndex
CREATE INDEX "ProposedFix_status_idx" ON "ProposedFix"("status");

-- CreateIndex
CREATE INDEX "ValidationRun_proposedFixId_createdAt_idx" ON "ValidationRun"("proposedFixId", "createdAt");

-- CreateIndex
CREATE INDEX "ValidationRun_overallStatus_idx" ON "ValidationRun"("overallStatus");

-- CreateIndex
CREATE UNIQUE INDEX "PullRequest_proposedFixId_key" ON "PullRequest"("proposedFixId");

-- CreateIndex
CREATE INDEX "PullRequest_githubPrNumber_idx" ON "PullRequest"("githubPrNumber");

-- CreateIndex
CREATE INDEX "PullRequest_status_idx" ON "PullRequest"("status");

-- AddForeignKey
ALTER TABLE "UserRepository" ADD CONSTRAINT "UserRepository_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserRepository" ADD CONSTRAINT "UserRepository_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "Repository"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Scan" ADD CONSTRAINT "Scan_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "Repository"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Finding" ADD CONSTRAINT "Finding_scanId_fkey" FOREIGN KEY ("scanId") REFERENCES "Scan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImpactAnalysis" ADD CONSTRAINT "ImpactAnalysis_findingId_fkey" FOREIGN KEY ("findingId") REFERENCES "Finding"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProposedFix" ADD CONSTRAINT "ProposedFix_findingId_fkey" FOREIGN KEY ("findingId") REFERENCES "Finding"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ValidationRun" ADD CONSTRAINT "ValidationRun_proposedFixId_fkey" FOREIGN KEY ("proposedFixId") REFERENCES "ProposedFix"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PullRequest" ADD CONSTRAINT "PullRequest_proposedFixId_fkey" FOREIGN KEY ("proposedFixId") REFERENCES "ProposedFix"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
