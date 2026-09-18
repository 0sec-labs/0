use super::*;
impl CampaignSnapshotData {
    pub(super) fn assemble(
        mut manifest: Manifest,
        values: Vec<(String, Vec<Vec<Cell>>)>,
        artifacts: BTreeMap<String, Vec<u8>>,
    ) -> Result<Self> {
        let mut blobs = BTreeMap::new();
        let mut total = 0usize;
        let mut expanded = 0usize;
        for (name, rows) in values {
            let mut references = vec![];
            for row in rows {
                let bytes = encode_row(&row, MAX_BYTES - expanded)?;
                expanded += bytes.len();
                references.push(split(&bytes, &mut blobs, &mut total)?);
            }
            manifest.tables.push(Table {
                name,
                rows: references,
            });
        }
        for (digest, bytes) in artifacts {
            expanded = expanded
                .checked_add(bytes.len())
                .filter(|n| *n <= MAX_BYTES)
                .ok_or_else(|| invalid("expanded records exceed byte bound"))?;
            if hash(&bytes) != digest {
                return Err(invalid("artifact hash differs"));
            }
            manifest
                .artifacts
                .insert(digest, split(&bytes, &mut blobs, &mut total)?);
        }
        manifest.total_unique_bytes = total as u64;
        let bytes = serde_json::to_vec(&manifest)?;
        if bytes.len() > MAX_MANIFEST || total.saturating_add(bytes.len()) > MAX_BYTES {
            return Err(invalid("package exceeds byte bound"));
        }
        Self::from_package(&bytes, |digest| {
            blobs
                .get(digest)
                .cloned()
                .ok_or_else(|| invalid("chunk absent"))
        })
    }
    pub fn from_package(
        manifest: &[u8],
        mut read: impl FnMut(&str) -> Result<Vec<u8>>,
    ) -> Result<Self> {
        if manifest.len() > MAX_MANIFEST {
            return Err(invalid("manifest exceeds bound"));
        }
        let parsed: Manifest = serde_json::from_slice(manifest)?;
        if parsed.schema_version != 1
            || parsed.store_schema != SNAPSHOT_STORE_LAYOUT
            || parsed.campaign_id.is_empty()
            || parsed.campaign_id.len() > 256
            || parsed.sessions.is_empty()
            || parsed.sessions.len() > 129
            || parsed
                .sessions
                .iter()
                .any(|s| s.is_empty() || s.len() > 256)
            || parsed.sessions.windows(2).any(|v| v[0] >= v[1])
            || parsed.tables.len() != TABLES.len()
            || parsed
                .tables
                .iter()
                .zip(TABLES)
                .any(|(table, expected)| table.name != *expected)
            || parsed.artifacts.len() > MAX_RECORDS
            || parsed.record_count as usize > MAX_RECORDS
            || parsed.total_unique_bytes as usize > MAX_BYTES
        {
            return Err(invalid("manifest identity, ordering or count differs"));
        }
        let count = parsed.tables.iter().map(|t| t.rows.len()).sum::<usize>();
        if count != parsed.record_count as usize || count > MAX_RECORDS {
            return Err(invalid("record count differs"));
        }
        let expanded = parsed
            .tables
            .iter()
            .flat_map(|t| &t.rows)
            .chain(parsed.artifacts.values())
            .try_fold(0u64, |sum, r| sum.checked_add(r.bytes))
            .ok_or_else(|| invalid("expanded byte overflow"))?;
        if expanded > MAX_BYTES as u64 {
            return Err(invalid("expanded records exceed byte bound"));
        }
        let mut blobs = BTreeMap::new();
        let mut total = 0usize;
        for reference in parsed
            .tables
            .iter()
            .flat_map(|t| &t.rows)
            .chain(parsed.artifacts.values())
        {
            let length =
                usize::try_from(reference.bytes).map_err(|_| invalid("record length overflow"))?;
            if length > MAX_BYTES
                || reference.chunks.len() > 16
                || reference.chunks.len() != length.div_ceil(MAX_CHUNK)
            {
                return Err(invalid("record/chunk length differs"));
            }
            for (index, digest) in reference.chunks.iter().enumerate() {
                if !zero_protocol::is_sha256(digest) {
                    return Err(invalid("invalid chunk digest"));
                }
                if !blobs.contains_key(digest) {
                    if blobs.len() >= 4096 {
                        return Err(invalid("too many chunks"));
                    }
                    let bytes = read(digest)?;
                    if bytes.is_empty() || bytes.len() > MAX_CHUNK || hash(&bytes) != *digest {
                        return Err(invalid("chunk bytes differ"));
                    }
                    total = total
                        .checked_add(bytes.len())
                        .ok_or_else(|| invalid("byte count overflow"))?;
                    if total > MAX_BYTES || total.saturating_add(manifest.len()) > MAX_BYTES {
                        return Err(invalid("package exceeds byte bound"));
                    }
                    blobs.insert(digest.clone(), bytes);
                }
                let expected = if index + 1 == reference.chunks.len() {
                    length - index * MAX_CHUNK
                } else {
                    MAX_CHUNK
                };
                if blobs[digest].len() != expected {
                    return Err(invalid("chunk length differs"));
                }
            }
        }
        if total as u64 != parsed.total_unique_bytes || serde_json::to_vec(&parsed)? != manifest {
            return Err(invalid("noncanonical manifest or byte count"));
        }
        if parsed
            .artifacts
            .keys()
            .any(|d| !zero_protocol::is_sha256(d))
        {
            return Err(invalid("invalid artifact digest"));
        }
        Ok(Self {
            manifest: parsed,
            bytes: manifest.to_vec(),
            digest: hash(manifest),
            blobs,
        })
    }
    pub(super) fn join(&self, reference: &Reference) -> Result<Vec<u8>> {
        let mut result = Vec::with_capacity(reference.bytes as usize);
        for digest in &reference.chunks {
            result.extend_from_slice(
                self.blobs
                    .get(digest)
                    .ok_or_else(|| invalid("chunk absent"))?,
            );
        }
        if result.len() as u64 != reference.bytes {
            return Err(invalid("joined length differs"));
        }
        Ok(result)
    }
}
fn split(
    bytes: &[u8],
    blobs: &mut BTreeMap<String, Vec<u8>>,
    total: &mut usize,
) -> Result<Reference> {
    if bytes.len() > MAX_BYTES {
        return Err(invalid("record exceeds bound"));
    }
    let mut chunks = vec![];
    for bytes in bytes.chunks(MAX_CHUNK) {
        let digest = hash(bytes);
        if !blobs.contains_key(&digest) {
            *total = total
                .checked_add(bytes.len())
                .ok_or_else(|| invalid("byte count overflow"))?;
            if *total > MAX_BYTES || blobs.len() >= 4096 {
                return Err(invalid("package exceeds bound"));
            }
            blobs.insert(digest.clone(), bytes.to_vec());
        }
        chunks.push(digest);
    }
    Ok(Reference {
        bytes: bytes.len() as u64,
        chunks,
    })
}

/// SQLite lengths exclude JSON escaping. Reject writes before their escaped
/// representation can exceed the remaining expanded package budget.
fn encode_row(row: &[Cell], maximum: usize) -> Result<Vec<u8>> {
    struct Bounded {
        bytes: Vec<u8>,
        maximum: usize,
    }
    impl std::io::Write for Bounded {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            if bytes.len() > self.maximum.saturating_sub(self.bytes.len()) {
                return Err(std::io::Error::other(
                    "campaign row encoding exceeds expanded byte bound",
                ));
            }
            self.bytes.extend_from_slice(bytes);
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    let mut output = Bounded {
        bytes: Vec::new(),
        maximum,
    };
    serde_json::to_writer(&mut output, row)?;
    Ok(output.bytes)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn source_row_escaping_is_capped_before_allocation() {
        let row = vec![Cell::Text("\0".repeat(4096))];
        // Raw source is 4 KiB; encoded source is over 24 KiB.
        assert!(
            encode_row(&row, 8192)
                .unwrap_err()
                .to_string()
                .contains("encoding exceeds expanded byte bound")
        );
        let expected = serde_json::to_vec(&row).unwrap();
        assert_eq!(encode_row(&row, expected.len()).unwrap(), expected);
        assert!(encode_row(&row, expected.len() - 1).is_err());
    }
}
