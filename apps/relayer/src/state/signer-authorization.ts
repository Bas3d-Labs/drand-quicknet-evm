/**
 * Owns process-local authorization only. Callers retain grant conditions and
 * ordering relative to journal acknowledgement, completion and gate reporting.
 * Persistence retry deliberately invokes none of the grant transitions.
 */
export class SignerAuthorization {
  private recoveryCompleteValue = false;
  private inclusionChecksCompleteValue = false;
  private broadcastPermitValue: string | undefined;

  get recoveryComplete(): boolean {
    return this.recoveryCompleteValue;
  }

  get inclusionChecksComplete(): boolean {
    return this.inclusionChecksCompleteValue;
  }

  get broadcastPermit(): string | undefined {
    return this.broadcastPermitValue;
  }

  inspectionBegun(): void {
    this.clearActionAuthorization();
  }

  inclusionCheckEntered(): void {
    this.clearActionAuthorization();
  }

  /** Called only when the inspection owns a bracket. */
  bracketFailed(): void {
    this.clearActionAuthorization();
  }

  abandonmentRequested(): void {
    this.clearActionAuthorization();
  }

  abandonmentCompleted(): void {
    this.clearActionAuthorization();
  }

  recoveryStarted(): void {
    this.clearAllAuthorization();
  }

  broadcastStarted(): void {
    this.clearAllAuthorization();
  }

  storedFactConflictBeforeSigning(): void {
    this.clearAllAuthorization();
  }

  preparationReachedStorageWithoutCompletion(): void {
    this.clearAllAuthorization();
  }

  terminalCorrectionCommitted(): void {
    this.clearAllAuthorization();
  }

  evidenceContradicted(): void {
    this.recoveryCompleteValue = false;
  }

  recoveryFailed(): void {
    this.recoveryCompleteValue = false;
  }

  inclusionCheckFailed(): void {
    this.inclusionChecksCompleteValue = false;
  }

  preparationStarted(): void {
    this.broadcastPermitValue = undefined;
  }

  preparationAboutToSave(): void {
    this.inclusionChecksCompleteValue = false;
  }

  preparationRolledBack(previousInclusionChecksComplete: boolean): void {
    this.inclusionChecksCompleteValue = previousInclusionChecksComplete;
  }

  recoveryCommitted(terminalCorrection: boolean): void {
    this.recoveryCompleteValue = !terminalCorrection;
  }

  bootstrapCommitted(): void {
    this.recoveryCompleteValue = true;
  }

  inclusionCheckCommitted(inclusionChecksComplete: boolean): void {
    this.inclusionChecksCompleteValue = inclusionChecksComplete;
  }

  grantPreparationPermit(attemptId: string): void {
    this.broadcastPermitValue = attemptId;
  }

  grantRecoveryPermit(attemptId: string): void {
    this.broadcastPermitValue = attemptId;
  }

  grantInclusionPermit(attemptId: string): void {
    this.broadcastPermitValue = attemptId;
  }

  private clearActionAuthorization(): void {
    this.broadcastPermitValue = undefined;
    this.inclusionChecksCompleteValue = false;
  }

  private clearAllAuthorization(): void {
    this.recoveryCompleteValue = false;
    this.clearActionAuthorization();
  }
}
