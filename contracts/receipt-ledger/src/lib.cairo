//! STRKWORLD ReceiptLedger: one receipt per fee-paying STRK20 pool transaction that STRKWORLD
//! sends, written by the player's canonical shadow account. See ../README.md for the argument.
//!
//! Not upgradeable and has no owner: the two constructor arguments are the whole configuration.

use starknet::ContractAddress;

/// Depth of the incremental Merkle tree: room for 2^20 (about one million) receipts.
pub const TREE_DEPTH: u32 = 20;
pub const MAX_LEAVES: u64 = 1048576; // 2^20

#[starknet::interface]
pub trait IReceiptLedger<T> {
    /// Records one receipt for `commitment`. The caller must be the canonical shadow account
    /// deployed for `commitment`; at most one receipt is recorded per transaction.
    fn tick(ref self: T, commitment: felt252);
    /// Receipts recorded under `commitment`.
    fn count_of(self: @T, commitment: felt252) -> u64;
    /// Current Merkle root over every receipt leaf, `poseidon(commitment, tx_hash)`.
    fn root(self: @T) -> felt252;
    /// Receipts recorded in total (the number of leaves).
    fn leaf_count(self: @T) -> u64;
    /// Whether `root` was the tree's root at some point (for claims against an older root).
    fn is_known_root(self: @T, root: felt252) -> bool;
    /// Whether a receipt was already recorded in the transaction `tx_hash`.
    fn is_counted(self: @T, tx_hash: felt252) -> bool;
    /// Distinct commitments that hold at least one receipt.
    fn distinct_commitments(self: @T) -> u64;
    fn anonymizer(self: @T) -> ContractAddress;
    fn pool(self: @T) -> ContractAddress;
}

/// The one view of the canonical ShadowAccountAnonymizer this contract needs.
/// Mainnet ABI (class 0xb61dee4f…af409): `get_shadow_account(felt252) -> ContractAddress`.
#[starknet::interface]
pub trait IShadowAnonymizer<T> {
    fn get_shadow_account(self: @T, identity_commitment: felt252) -> ContractAddress;
}

/// The one view of the STRK20 pool this contract needs. Mainnet: `get_fee_amount() -> u128`.
#[starknet::interface]
pub trait IPoolFee<T> {
    fn get_fee_amount(self: @T) -> u128;
}

/// Merkle node hash: `poseidon_hash_many([left, right])`, the same as starknet.js
/// `hash.computePoseidonHashOnElements([left, right])`.
pub fn hash_pair(left: felt252, right: felt252) -> felt252 {
    core::poseidon::poseidon_hash_span(array![left, right].span())
}

/// Leaf for one receipt. Unique per receipt because each transaction counts at most once.
pub fn receipt_leaf(commitment: felt252, tx_hash: felt252) -> felt252 {
    hash_pair(commitment, tx_hash)
}

pub mod errors {
    pub const NOT_SHADOW: felt252 = 'LEDGER: caller not shadow';
    pub const TX_COUNTED: felt252 = 'LEDGER: tx already counted';
    pub const TREE_FULL: felt252 = 'LEDGER: tree full';
    pub const ZERO_ADDRESS: felt252 = 'LEDGER: zero address';
}

#[starknet::contract]
pub mod ReceiptLedger {
    use core::num::traits::Zero;
    use starknet::storage::{
        Map, StorageMapReadAccess, StorageMapWriteAccess, StoragePointerReadAccess,
        StoragePointerWriteAccess,
    };
    use starknet::{ContractAddress, get_caller_address, get_tx_info};
    use super::{
        IPoolFeeDispatcher, IPoolFeeDispatcherTrait, IShadowAnonymizerDispatcher,
        IShadowAnonymizerDispatcherTrait, MAX_LEAVES, TREE_DEPTH, errors, hash_pair, receipt_leaf,
    };

    #[storage]
    struct Storage {
        anonymizer: ContractAddress,
        pool: ContractAddress,
        counted_tx: Map<felt252, bool>,
        count: Map<felt252, u64>,
        distinct: u64,
        leaf_count: u64,
        /// Left-hand node per level of the rightmost path (the tree's frontier).
        frontier: Map<u32, felt252>,
        root: felt252,
        known_root: Map<felt252, bool>,
    }

    #[event]
    #[derive(Drop, starknet::Event)]
    pub enum Event {
        Receipt: Receipt,
    }

    #[derive(Drop, starknet::Event)]
    pub struct Receipt {
        #[key]
        pub commitment: felt252,
        pub index: u64,
        pub leaf: felt252,
        pub root: felt252,
    }

    #[constructor]
    fn constructor(ref self: ContractState, anonymizer: ContractAddress, pool: ContractAddress) {
        assert(anonymizer.is_non_zero() && pool.is_non_zero(), errors::ZERO_ADDRESS);
        self.anonymizer.write(anonymizer);
        self.pool.write(pool);
        // Root of the empty tree: zero leaves hashed up TREE_DEPTH levels.
        let mut node = 0;
        for _ in 0..TREE_DEPTH {
            node = hash_pair(node, node);
        }
        self.root.write(node);
        self.known_root.write(node, true);
    }

    #[abi(embed_v0)]
    impl ReceiptLedgerImpl of super::IReceiptLedger<ContractState> {
        fn tick(ref self: ContractState, commitment: felt252) {
            // 1. Only the canonical shadow account for `commitment` may tick. A shadow executes
            //    only when the anonymizer drives it, and the anonymizer only when the pool calls
            //    it from `apply_actions`, after `collect_fee`.
            let caller = get_caller_address();
            let shadow = IShadowAnonymizerDispatcher { contract_address: self.anonymizer.read() }
                .get_shadow_account(commitment);
            assert(caller.is_non_zero() && shadow == caller, errors::NOT_SHADOW);

            // 2. If governance ever sets the pool fee to zero, the transaction paid no fee and
            //    earns no receipt. Skip rather than revert, so the player's action still lands.
            let fee = IPoolFeeDispatcher { contract_address: self.pool.read() }.get_fee_amount();
            if fee == 0 {
                return;
            }

            // 3. At most one receipt per transaction, so one fee is never counted twice.
            let tx_hash = get_tx_info().unbox().transaction_hash;
            assert(!self.counted_tx.read(tx_hash), errors::TX_COUNTED);
            self.counted_tx.write(tx_hash, true);

            // 4. Append the leaf to the incremental Merkle tree.
            let index = self.leaf_count.read();
            assert(index < MAX_LEAVES, errors::TREE_FULL);
            let leaf = receipt_leaf(commitment, tx_hash);
            let mut node = leaf;
            let mut zero = 0;
            let mut i = index;
            for level in 0..TREE_DEPTH {
                if i % 2 == 0 {
                    self.frontier.write(level, node);
                    node = hash_pair(node, zero);
                } else {
                    node = hash_pair(self.frontier.read(level), node);
                }
                zero = hash_pair(zero, zero);
                i /= 2;
            }
            self.root.write(node);
            self.known_root.write(node, true);
            self.leaf_count.write(index + 1);

            // 5. Count it.
            let prior = self.count.read(commitment);
            if prior == 0 {
                self.distinct.write(self.distinct.read() + 1);
            }
            self.count.write(commitment, prior + 1);
            self.emit(Receipt { commitment, index, leaf, root: node });
        }

        fn count_of(self: @ContractState, commitment: felt252) -> u64 {
            self.count.read(commitment)
        }

        fn root(self: @ContractState) -> felt252 {
            self.root.read()
        }

        fn leaf_count(self: @ContractState) -> u64 {
            self.leaf_count.read()
        }

        fn is_known_root(self: @ContractState, root: felt252) -> bool {
            self.known_root.read(root)
        }

        fn is_counted(self: @ContractState, tx_hash: felt252) -> bool {
            self.counted_tx.read(tx_hash)
        }

        fn distinct_commitments(self: @ContractState) -> u64 {
            self.distinct.read()
        }

        fn anonymizer(self: @ContractState) -> ContractAddress {
            self.anonymizer.read()
        }

        fn pool(self: @ContractState) -> ContractAddress {
            self.pool.read()
        }
    }
}
