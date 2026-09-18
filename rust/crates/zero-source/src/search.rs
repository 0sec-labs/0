//! Shared bounded line matcher. Regex uses finite automata, never backtracking.
use regex::{Regex, RegexBuilder};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SearchMode {
    #[default]
    Literal,
    Regex,
}
pub const MAX_REGEX_COMPILED_BYTES: usize = 256 * 1024;
pub const MAX_REGEX_DFA_BYTES: usize = 256 * 1024;
pub const MAX_REGEX_NESTING: u32 = 32;
pub(crate) enum Matcher<'a> {
    Literal(&'a str),
    Regex(Regex),
}
impl<'a> Matcher<'a> {
    pub(crate) fn new(
        query: &'a str,
        mode: SearchMode,
        case_sensitive: bool,
    ) -> Result<Self, &'static str> {
        if query.is_empty()
            || query.len() > crate::investigation::MAX_SEARCH_QUERY_BYTES
            || query.contains(['\r', '\n', '\0'])
        {
            return Err("search requires 1..256 UTF-8 bytes without line breaks or NUL");
        }
        if mode == SearchMode::Literal && case_sensitive {
            return Ok(Self::Literal(query));
        }
        let pattern = match mode {
            SearchMode::Literal => regex::escape(query),
            SearchMode::Regex => query.into(),
        };
        let regex = RegexBuilder::new(&pattern)
            .case_insensitive(!case_sensitive)
            .size_limit(MAX_REGEX_COMPILED_BYTES)
            .dfa_size_limit(MAX_REGEX_DFA_BYTES)
            .nest_limit(MAX_REGEX_NESTING)
            .build()
            .map_err(|_| "invalid regex or regex exceeds compilation limits; look-around and backreferences are unsupported")?;
        Ok(Self::Regex(regex))
    }
    pub(crate) fn matches(&self, line: &str) -> bool {
        match self {
            Self::Literal(query) => line.contains(query),
            Self::Regex(regex) => {
                let logical = line
                    .strip_suffix('\n')
                    .map(|line| line.strip_suffix('\r').unwrap_or(line))
                    .unwrap_or(line);
                regex.is_match(logical)
            }
        }
    }
}
