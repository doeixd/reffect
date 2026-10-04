//! The static runtime modules generated crates inline, as siblings at the crate root so their
//! `super::` paths resolve as they do there. Each file is a module body; the emitters wrap it.

#[allow(dead_code)]
pub mod foldkit_eval;
#[allow(dead_code)]
pub mod foldkit_html;
#[allow(dead_code)]
pub mod foldkit_json;
#[allow(dead_code)]
mod foldkit_ssr;
#[allow(dead_code)]
mod remote_engine;

#[cfg(test)]
mod tests;
