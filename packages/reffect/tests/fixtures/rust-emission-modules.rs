pub mod generated {
    pub use std::collections::{HashMap, hash_map::{self, HashMap as Map}};

    #[macro_export]
    macro_rules! identity {
        ($value:expr) => {$value};
    }

    macro_rules! array {
        ($($value:expr),*) => {[$($value),*]};
    }

    pub fn answer() -> u64 {
        identity!(42u64)
    }

    pub fn pair() -> [u64; 2] {
        array!(1u64, 2u64)
    }
}

pub use crate::generated::{self as api, answer as answer_public};
