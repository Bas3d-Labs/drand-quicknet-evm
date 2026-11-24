/** An acknowledged write cannot complete in this coordinator instance. */
export class SignerRestartRequiredError extends Error {
  constructor() {
    super(
      'Journal persistence was acknowledged, but coordinator ' +
      'completion failed. The committed journal is retained. ' +
      'Restart the relayer to reload it and run recovery; ' +
      'persistence retry is unavailable.',
    );

    this.name = 'SignerRestartRequiredError';
  }
}
