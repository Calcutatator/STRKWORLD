use receipt_ledger::ReceiptLedger::{Event as LedgerEvent, Receipt};
use receipt_ledger::{
    IReceiptLedgerDispatcher, IReceiptLedgerDispatcherTrait, TREE_DEPTH, hash_pair, receipt_leaf,
};
use snforge_std::{
    ContractClassTrait, DeclareResultTrait, EventSpyAssertionsTrait, declare, spy_events,
    start_cheat_caller_address, start_cheat_transaction_hash, stop_cheat_caller_address,
};
use starknet::ContractAddress;

/// Stand-in for the canonical ShadowAccountAnonymizer: same `get_shadow_account` view, plus a
/// setter so a test can say which address is the shadow for which commitment.
#[starknet::interface]
trait IMockAnonymizer<T> {
    fn set_shadow(ref self: T, commitment: felt252, shadow: ContractAddress);
    fn get_shadow_account(self: @T, identity_commitment: felt252) -> ContractAddress;
}

#[starknet::contract]
mod MockAnonymizer {
    use starknet::ContractAddress;
    use starknet::storage::{Map, StorageMapReadAccess, StorageMapWriteAccess};

    #[storage]
    struct Storage {
        shadows: Map<felt252, ContractAddress>,
    }

    #[abi(embed_v0)]
    impl Impl of super::IMockAnonymizer<ContractState> {
        fn set_shadow(ref self: ContractState, commitment: felt252, shadow: ContractAddress) {
            self.shadows.write(commitment, shadow);
        }
        fn get_shadow_account(
            self: @ContractState, identity_commitment: felt252,
        ) -> ContractAddress {
            self.shadows.read(identity_commitment)
        }
    }
}

#[starknet::interface]
trait IMockPool<T> {
    fn set_fee_amount(ref self: T, fee: u128);
    fn get_fee_amount(self: @T) -> u128;
}

#[starknet::contract]
mod MockPool {
    use starknet::storage::{StoragePointerReadAccess, StoragePointerWriteAccess};

    #[storage]
    struct Storage {
        fee: u128,
    }

    #[constructor]
    fn constructor(ref self: ContractState) {
        self.fee.write(6_000_000_000_000_000_000);
    }

    #[abi(embed_v0)]
    impl Impl of super::IMockPool<ContractState> {
        fn set_fee_amount(ref self: ContractState, fee: u128) {
            self.fee.write(fee);
        }
        fn get_fee_amount(self: @ContractState) -> u128 {
            self.fee.read()
        }
    }
}

const C1: felt252 = 0x111;
const C2: felt252 = 0x222;

fn shadow1() -> ContractAddress {
    0x5a1.try_into().unwrap()
}
fn shadow2() -> ContractAddress {
    0x5a2.try_into().unwrap()
}
fn stranger() -> ContractAddress {
    0xbad.try_into().unwrap()
}

#[derive(Drop, Copy)]
struct Setup {
    ledger: IReceiptLedgerDispatcher,
    anonymizer: IMockAnonymizerDispatcher,
    pool: IMockPoolDispatcher,
}

fn setup() -> Setup {
    let (anon_addr, _) = declare("MockAnonymizer")
        .unwrap()
        .contract_class()
        .deploy(@array![])
        .unwrap();
    let (pool_addr, _) = declare("MockPool").unwrap().contract_class().deploy(@array![]).unwrap();
    let anonymizer = IMockAnonymizerDispatcher { contract_address: anon_addr };
    anonymizer.set_shadow(C1, shadow1());
    anonymizer.set_shadow(C2, shadow2());
    let (ledger_addr, _) = declare("ReceiptLedger")
        .unwrap()
        .contract_class()
        .deploy(@array![anon_addr.into(), pool_addr.into()])
        .unwrap();
    Setup {
        ledger: IReceiptLedgerDispatcher { contract_address: ledger_addr },
        anonymizer,
        pool: IMockPoolDispatcher { contract_address: pool_addr },
    }
}

/// Ticks as `shadow` inside the transaction `tx_hash`.
fn tick_as(s: @Setup, shadow: ContractAddress, commitment: felt252, tx_hash: felt252) {
    let ledger = *s.ledger;
    start_cheat_caller_address(ledger.contract_address, shadow);
    start_cheat_transaction_hash(ledger.contract_address, tx_hash);
    ledger.tick(commitment);
    stop_cheat_caller_address(ledger.contract_address);
}

/// Reference root, computed the slow way: build every level of a depth-20 tree whose leaves
/// are `leaves` followed by zeros. Independent of the contract's frontier algorithm.
fn reference_root(leaves: Span<felt252>) -> felt252 {
    let mut level: Array<felt252> = leaves.into();
    let mut zero = 0;
    for _ in 0..TREE_DEPTH {
        let mut next: Array<felt252> = array![];
        let n = level.len();
        let mut i = 0;
        while i < n {
            let right = if i + 1 < n {
                *level.at(i + 1)
            } else {
                zero
            };
            next.append(hash_pair(*level.at(i), right));
            i += 2;
        }
        if next.len() == 0 {
            next.append(hash_pair(zero, zero));
        }
        level = next;
        zero = hash_pair(zero, zero);
    }
    let root = *level.at(0);
    root
}

#[test]
fn genuine_shadow_can_tick() {
    let s = setup();
    tick_as(@s, shadow1(), C1, 0xa1);
    assert_eq!(s.ledger.count_of(C1), 1);
    assert_eq!(s.ledger.leaf_count(), 1);
    assert!(s.ledger.is_counted(0xa1));
}

#[test]
#[should_panic(expected: 'LEDGER: caller not shadow')]
fn stranger_cannot_tick() {
    let s = setup();
    tick_as(@s, stranger(), C1, 0xa1);
}

#[test]
#[should_panic(expected: 'LEDGER: caller not shadow')]
fn shadow_cannot_tick_for_another_commitment() {
    let s = setup();
    // shadow2 is genuine, but for C2: it cannot mint a receipt under C1.
    tick_as(@s, shadow2(), C1, 0xa1);
}

#[test]
#[should_panic(expected: 'LEDGER: caller not shadow')]
fn undeployed_commitment_cannot_tick() {
    let s = setup();
    // The anonymizer returns zero for a commitment with no shadow; zero is never accepted.
    start_cheat_caller_address(s.ledger.contract_address, 0.try_into().unwrap());
    start_cheat_transaction_hash(s.ledger.contract_address, 0xa1);
    s.ledger.tick(0x999);
}

#[test]
#[should_panic(expected: 'LEDGER: tx already counted')]
fn double_tick_in_one_tx_is_rejected() {
    let s = setup();
    tick_as(@s, shadow1(), C1, 0xa1);
    tick_as(@s, shadow1(), C1, 0xa1);
}

#[test]
#[should_panic(expected: 'LEDGER: tx already counted')]
fn two_shadows_in_one_tx_count_once() {
    let s = setup();
    tick_as(@s, shadow1(), C1, 0xa1);
    tick_as(@s, shadow2(), C2, 0xa1);
}

#[test]
fn counts_and_root_update() {
    let s = setup();
    let empty = s.ledger.root();
    assert_eq!(empty, reference_root(array![].span()));
    assert!(s.ledger.is_known_root(empty));

    tick_as(@s, shadow1(), C1, 0xa1);
    let r1 = s.ledger.root();
    assert_ne!(r1, empty);
    tick_as(@s, shadow1(), C1, 0xa2);
    tick_as(@s, shadow2(), C2, 0xa3);

    assert_eq!(s.ledger.count_of(C1), 2);
    assert_eq!(s.ledger.count_of(C2), 1);
    assert_eq!(s.ledger.count_of(0x333), 0);
    assert_eq!(s.ledger.leaf_count(), 3);
    assert_eq!(s.ledger.distinct_commitments(), 2);

    let leaves = array![receipt_leaf(C1, 0xa1), receipt_leaf(C1, 0xa2), receipt_leaf(C2, 0xa3)];
    assert_eq!(s.ledger.root(), reference_root(leaves.span()));
    // Older roots stay valid for claims made against them.
    assert!(s.ledger.is_known_root(r1));
    assert!(!s.ledger.is_known_root(0x1234));
}

#[test]
fn root_matches_reference_over_many_leaves() {
    let s = setup();
    let mut leaves: Array<felt252> = array![];
    let mut t: felt252 = 1;
    for _ in 0..9_u32 {
        tick_as(@s, shadow1(), C1, t);
        leaves.append(receipt_leaf(C1, t));
        t += 1;
    }
    assert_eq!(s.ledger.root(), reference_root(leaves.span()));
    assert_eq!(s.ledger.count_of(C1), 9);
}

#[test]
fn poseidon_matches_starknet_js() {
    // starknet.js 10.8.0: hash.computePoseidonHashOnElements([1, 2])
    assert_eq!(hash_pair(1, 2), 0x371cb6995ea5e7effcd2e174de264b5b407027a75a231a70c2c8d196107f0e7);
}

#[test]
fn zero_fee_skips_without_reverting() {
    let s = setup();
    s.pool.set_fee_amount(0);
    tick_as(@s, shadow1(), C1, 0xa1);
    assert_eq!(s.ledger.count_of(C1), 0);
    assert_eq!(s.ledger.leaf_count(), 0);
    assert!(!s.ledger.is_counted(0xa1));
}

#[test]
fn tick_emits_receipt() {
    let s = setup();
    let mut spy = spy_events();
    tick_as(@s, shadow1(), C1, 0xa1);
    let root = s.ledger.root();
    spy
        .assert_emitted(
            @array![
                (
                    s.ledger.contract_address,
                    LedgerEvent::Receipt(
                        Receipt { commitment: C1, index: 0, leaf: receipt_leaf(C1, 0xa1), root },
                    ),
                ),
            ],
        );
}

#[test]
fn views_return_constructor_args() {
    let s = setup();
    assert_eq!(s.ledger.anonymizer(), s.anonymizer.contract_address);
    assert_eq!(s.ledger.pool(), s.pool.contract_address);
}
// The constructor's zero-address assert is not tested here: snforge 0.52 surfaces a constructor
// panic as an uncatchable execution error, which neither `should_panic` nor `deploy`'s Result
// can observe.


