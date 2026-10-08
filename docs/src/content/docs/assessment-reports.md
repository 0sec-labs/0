---
title: Assessment Reports
description: Collect retained runs and findings into a reviewable report with source provenance.
---

Open **Findings → Assessment reports** in `0 web`. Create a named report,
record the objective and scope, select the runs to include, and add review notes.
Save the selection before exporting JSON or Markdown.

Reports combine finding families by their recorded fingerprint and retain each
source run, finding ID, and evidence. Findings without a fingerprint remain
separate. Conflicting review states stay **Unreviewed**. Confirmation or acceptance
alone does not count as verification.

This is a collection of selected retained evidence. An empty collection, a
completed run, or an export does not prove complete asset coverage. Reconstructed
legacy reports include their evidence-coverage warnings. Historical cost and
human time saved are not inferred.

## Reuse findings in another conversation

Open the chat's **Details** panel and choose **Add an existing finding**. Search
for a title, severity, or source, then add the finding to your message. Its stored
finding and scan IDs travel with the reference. Your existing draft is preserved,
and attaching the same finding again does not duplicate the reference.

## Reporting API

The selected engine exposes these authenticated endpoints:

| Method | Path | Result |
| --- | --- | --- |
| GET | `/api/engagements` | Saved assessment report collections for the engine workspace |
| POST | `/api/engagements` | Create a collection with `name`, optional `description`, `scanIds`, and `notes` |
| GET | `/api/engagements/:id` | Collection metadata |
| PATCH | `/api/engagements/:id` | Update the collection fields |
| GET | `/api/engagements/:id/report` | Versioned JSON report with exact coverage, source runs, finding groups, evidence, and counts |
| GET | `/api/engagements/:id/report?format=markdown` | Markdown handoff report |

Use the engine's configured bearer credential for external integrations. Browser
requests use the page-bound control credential. Collections are scoped to the
engine's canonical workspace and stored locally; they do not grant access to
another engine. Missing run IDs are rejected rather than silently omitted.
Selections support up to 100 retained runs.

## Local use and team use

The local web app remains account-free. Report collections and cross-chat finding
references are local collaboration primitives. They do not provide team login,
membership, permission enforcement, shared presence, or concurrent editing.
Authenticated multi-operator collaboration belongs in the managed service's
identity and organization layer. Exporting a report does not send it to a third
party automatically.
