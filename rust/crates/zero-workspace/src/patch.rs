//! The legacy Begin Patch DSL, applied atomically to an in-memory generation.
pub enum Op {
    Add {
        path: String,
        content: String,
        replace: bool,
    },
    Delete {
        path: String,
    },
    Update {
        path: String,
        hunks: Vec<Hunk>,
    },
}
pub struct Hunk {
    anchor: String,
    body: Vec<String>,
}
fn header(s: &str) -> bool {
    [
        "*** Add File:",
        "*** Replace File:",
        "*** Update File:",
        "*** Delete File:",
    ]
    .iter()
    .any(|p| s.starts_with(p))
}
pub fn parse(input: &str) -> Result<Vec<Op>, String> {
    let normalized = input.replace("\r\n", "\n");
    let mut lines: Vec<_> = normalized.split('\n').collect();
    if lines.last() == Some(&"") {
        lines.pop();
    }
    if lines.first().map(|s| s.trim()) != Some("*** Begin Patch")
        || lines.last().map(|s| s.trim()) != Some("*** End Patch")
    {
        return Err("patch requires Begin Patch and End Patch envelope".into());
    }
    let body = &lines[1..lines.len() - 1];
    let mut i = 0;
    let mut ops = vec![];
    while i < body.len() {
        let line = body[i].trim();
        if line.is_empty() {
            i += 1;
            continue;
        }
        if ops.len() >= 32 {
            return Err("patch operation limit32".into());
        }
        let (kind, path) = line.split_once(": ").ok_or("unknown patch directive")?;
        if !zero_protocol::workspace_edit::valid_path(path) {
            return Err("patch relative path invalid".into());
        }
        i += 1;
        match kind {
            "*** Add File" | "*** Replace File" => {
                let mut content = String::new();
                while i < body.len() && !header(body[i]) {
                    let line = body[i]
                        .strip_prefix('+')
                        .ok_or("Add/Replace File body requires + lines")?;
                    content.push_str(line);
                    content.push('\n');
                    i += 1;
                }
                ops.push(Op::Add {
                    path: path.into(),
                    content,
                    replace: kind == "*** Replace File",
                });
            }
            "*** Delete File" => ops.push(Op::Delete { path: path.into() }),
            "*** Update File" => {
                let mut hunks = vec![];
                while i < body.len() && !header(body[i]) {
                    let anchor = body[i]
                        .strip_prefix("@@")
                        .ok_or("Update File requires @@ anchor")?
                        .trim()
                        .to_owned();
                    i += 1;
                    let mut entries = vec![];
                    while i < body.len() && !header(body[i]) && !body[i].starts_with("@@") {
                        let line = body[i];
                        if !line.starts_with([' ', '+', '-']) {
                            return Err("patch hunk requires context/add/delete prefix".into());
                        }
                        entries.push(line.to_owned());
                        i += 1;
                    }
                    if entries.is_empty() || hunks.len() >= 128 {
                        return Err("patch hunk empty or limit128".into());
                    }
                    hunks.push(Hunk {
                        anchor,
                        body: entries,
                    });
                }
                if hunks.is_empty() {
                    return Err("Update File has no hunks".into());
                }
                ops.push(Op::Update {
                    path: path.into(),
                    hunks,
                });
            }
            _ => return Err("unknown patch directive".into()),
        }
    }
    if ops.is_empty() {
        return Err("patch has no operations".into());
    }
    Ok(ops)
}
pub fn update(source: &str, hunks: &[Hunk]) -> Result<String, String> {
    let trailing = source.ends_with('\n');
    let body = source.strip_suffix('\n').unwrap_or(source);
    let mut lines: Vec<String> = body.split('\n').map(str::to_owned).collect();
    for h in hunks {
        let index = if h.anchor.is_empty() {
            0
        } else {
            let matches: Vec<_> = lines
                .iter()
                .enumerate()
                .filter(|(_, line)| line.contains(&h.anchor))
                .map(|(i, _)| i)
                .collect();
            if matches.len() != 1 {
                return Err("patch anchor missing or ambiguous".into());
            }
            matches[0]
        };
        let mut consumed = 0;
        let mut replacement = vec![];
        for entry in &h.body {
            let text = &entry[1..];
            match entry.as_bytes()[0] {
                b' ' | b'-' => {
                    if lines.get(index + consumed).map(String::as_str) != Some(text) {
                        return Err("patch preimage/context mismatch".into());
                    }
                    consumed += 1;
                    if entry.starts_with(' ') {
                        replacement.push(text.to_owned());
                    }
                }
                b'+' => replacement.push(text.to_owned()),
                _ => return Err("patch body invalid".into()),
            }
        }
        lines.splice(index..index + consumed, replacement);
    }
    let mut output = lines.join("\n");
    if trailing {
        output.push('\n');
    }
    Ok(output)
}
