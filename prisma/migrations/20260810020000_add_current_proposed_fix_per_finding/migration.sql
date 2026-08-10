-- A finding has one current proposed-fix snapshot. Re-generating a verified
-- proposal replaces that snapshot instead of creating an unbounded history.
CREATE UNIQUE INDEX "ProposedFix_findingId_key" ON "ProposedFix"("findingId");
