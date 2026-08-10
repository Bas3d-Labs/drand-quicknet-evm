// SPDX-License-Identifier: MIT
pragma solidity ^0.8.36;

/// @title IQuicknetRandomnessConsumer
/// @notice Standard demand signal for contracts that consume drand Quicknet
///         randomness through a shared beacon registry.
/// @dev
/// Consumers emit `QuicknetRandomnessRequested` only after they have committed
/// to an exact Quicknet round.
///
/// Relayers use this event solely as a signal that the specified round should
/// be made available in the consumer's configured beacon registry.
///
/// Relayers MUST service the exact requested round. They MUST NOT substitute
/// another round based on availability, insertion order, freshness, or any
/// other criterion.
///
/// Emitting this event does not grant the relayer any authority over settlement,
/// outcome selection, callbacks, or application state.
interface IQuicknetRandomnessConsumer {
    /// @notice Signals demand for an exact drand Quicknet round.
    /// @param round The exact Quicknet round the consumer has committed to.
    /// @dev
    /// The commitment to `round` MUST already be fixed before this event is
    /// emitted.
    ///
    /// Multiple consumers may request the same round. Relayers may deduplicate
    /// such requests because the beacon registry stores a single canonical
    /// randomness value for each round.
    event QuicknetRandomnessRequested(
        uint64 indexed round
    );

    /// @notice Returns the Quicknet beacon registry used by this consumer.
    /// @dev
    /// Reference relayers should verify that this address matches the registry
    /// deployment they are configured to service before acting on request
    /// events from the consumer.
    function quicknetBeaconRegistry()
        external
        view
        returns (address);
}