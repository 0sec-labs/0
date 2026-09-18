# 0sec Scan Report

| Field | Value |
|-------|-------|
| Target | https://example.com |
| Depth | deep |
| Started | 2026-09-18T00:00:00.000Z |
| Duration | 12.0s |

## Summary

- **Attacks:** 3
- **Findings:** 1
- **High:** 1

## Warnings

- **verify:** A probe timed out

## Findings

### [HIGH] SQL injection in /search

- **Category:** injection
- **Status:** discovered
- **CVSS:** 9.8 (`CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H`)
- **Confidence:** 75%
- **Triage:** Requires further verification
- **Description:** The q parameter reaches a raw query.

**Evidence:** Response differed

**Reproduction steps:**

1. **[setup]** Log in as a low-priv user
2. **[exploit]** POST the crafted payload

**Remediation:**

Use a parameterised query.

1. Replace string concatenation
1. Add a regression test

<details>
<summary>Suggested change</summary>

Before:

```ts
q + input
```

After:

```ts
db.query(sql, [input])
```
</details>

References:
- https://owasp.org/sqli

<details>
<summary>Request / Response</summary>

**Request:**
```
GET /search?q=1
```

**Response:**
```
HTTP/1.1 500
```
</details>
