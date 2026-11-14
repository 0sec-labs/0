---
title: Inline visualizations
description: Graphs, attack paths, charts, timelines, tables and diagrams that the agent can show inside a chat.
---

The agent can call the `visualize` tool to put a visual in the mission, for
example an attack path, a timeline of an incident or a table of findings.
Visuals are saved with the mission and replay when you reopen it.

## Formats

| `kind` | Use for |
| --- | --- |
| `graph`, `attack-graph` | Nodes and edges (hosts, services, identities, vulnerabilities, steps) with optional severity and ordered steps. Layouts: layered, force, radial. |
| `chart` | `bar`, `line`, `area`, `pie` or `stacked`. |
| `timeline` | Dated events. |
| `table` | Columns and rows. |
| `mermaid` | Sequence or flow diagram source. |

Every visual needs a title and a summary. The summary is the alt text and
should state the conclusion.

## Caps

Validation fails and the model is asked to retry; nothing is silently truncated.

| Limit | Value |
| --- | --- |
| Spec size | 64 KB |
| Graph | 200 nodes, 400 edges, 30 groups |
| Chart | 12 series, 500 points per series, 2000 in total |
| Timeline | 200 events |
| Table | 20 columns, 500 rows |
| Mermaid source | 10,000 bytes |
| Per mission | 200 visuals |

Titles are at most 120 characters, summaries 600, captions 300, labels 80.

## Safety rules

- A spec is declarative data. Every string is plain text: HTML-like markup,
  entities, URLs and schemes (`javascript:`, `data:`, `www.`), control
  characters, zero-width characters and bidi overrides are rejected.
- Links are symbolic. A node can reference a finding id, a file or an agent id
  that the app resolves against its own records; it is never a URL.
- The browser renders the visual with its own components, treats all fields as
  untrusted text, and sanitises Mermaid (no click handlers, no script labels, no
  `securityLevel` overrides).
- The agent is told to shorten labels and never copy target-controlled text
  verbatim, because target content is attacker-controlled.
