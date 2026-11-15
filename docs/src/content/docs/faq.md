---
title: FAQ
description: Short answers about what 0security is, how it runs, which models it uses and how to start.
head:
  - tag: script
    attrs:
      type: application/ld+json
    content: |
        {
          "@context": "https://schema.org",
          "@type": "FAQPage",
          "mainEntity": [
            {
              "@type": "Question",
              "name": "What is 0security?",
              "acceptedAnswer": {
                "@type": "Answer",
                "text": "0security is a framework for building security agents. They find vulnerabilities across your code, dependencies, infrastructure and AI agents, prove them, fix them, verify the fix and keep watching."
              }
            },
            {
              "@type": "Question",
              "name": "Is 0security open source?",
              "acceptedAnswer": {
                "@type": "Answer",
                "text": "Yes. The code is licensed under MIT or Apache-2.0, at your option, and is developed in the open at github.com/0sec-labs/0security."
              }
            },
            {
              "@type": "Question",
              "name": "Can I run it on my own infrastructure?",
              "acceptedAnswer": {
                "@type": "Answer",
                "text": "Yes. 0 runs on your computer, in your CI runner or in a container, with your own model key. Code and context go to the model provider you choose. Some workflows also call outside services, such as OSV, package registries and web search."
              }
            },
            {
              "@type": "Question",
              "name": "Which models does it support?",
              "acceptedAnswer": {
                "@type": "Answer",
                "text": "0 uses your own provider: Anthropic, OpenAI, ChatGPT Codex, OpenRouter, Azure OpenAI, DeepSeek, Z.ai GLM, Moonshot Kimi, Alibaba Qwen, xAI Grok, OpenCode Zen and Together AI. Any OpenAI-compatible server, local or remote, also works."
              }
            },
            {
              "@type": "Question",
              "name": "What can it scan?",
              "acceptedAnswer": {
                "@type": "Answer",
                "text": "Source repositories and pull request diffs, live web apps, APIs and MCP endpoints, and npm, pnpm, Cargo and PyPI dependencies. It also tests AI agents and LLM endpoints for prompt injection and jailbreaks, and includes specialist workflows for binaries, cloud and Entra ID posture."
              }
            },
            {
              "@type": "Question",
              "name": "How does it prove and fix a vulnerability?",
              "acceptedAnswer": {
                "@type": "Answer",
                "text": "A finding is a claim until verification reproduces it. A fix is accepted only when the patched code no longer reproduces the finding and your tests still pass."
              }
            },
            {
              "@type": "Question",
              "name": "What are persistent security agents (Agents)?",
              "acceptedAnswer": {
                "@type": "Answer",
                "text": "An Agent is a named agent with a scope, a tool-access level, a daily budget and memory. It runs threads on a schedule, when a GitHub pull request opens, or when you start it by hand."
              }
            },
            {
              "@type": "Question",
              "name": "Does it work in CI?",
              "acceptedAnswer": {
                "@type": "Answer",
                "text": "Yes. The GitHub Action runs 0 on your own runner with your own model key, applies a severity gate and writes JSON and SARIF reports. Other CI systems can run the CLI directly."
              }
            },
            {
              "@type": "Question",
              "name": "Is it safe to point at my systems?",
              "acceptedAnswer": {
                "@type": "Answer",
                "text": "Only scan systems you own or are authorized to test. A scope file limits live testing to the hosts you list, but it is not a sandbox. New Agents start paused, read-only and with production targets off."
              }
            },
            {
              "@type": "Question",
              "name": "How do I get started?",
              "acceptedAnswer": {
                "@type": "Answer",
                "text": "Install with the one-line installer, run `0`, connect a model provider and start a thread in the browser app."
              }
            }
          ]
        }
---

## What is 0security?

0security is a framework for building security agents. They find vulnerabilities across your code, dependencies, infrastructure and AI agents, prove them, fix them, verify the fix and keep watching. Start with the [Quickstart](/) and the [concepts](/concepts/).

## Is 0security open source?

Yes. The code is licensed under MIT or Apache-2.0, at your option, and is developed in the open at [github.com/0sec-labs/0security](https://github.com/0sec-labs/0security). Third-party licenses are listed in [Third-party notices](/third-party-notices/).

## Can I run it on my own infrastructure?

Yes. 0 runs on your computer, in your CI runner or in a [container](/docker/), with your own model key. Code and context go to the model provider you choose. Some workflows also call outside services, such as OSV, package registries and web search; see [Keep model traffic in one region](/models/#keep-model-traffic-in-one-region).

## Which models does it support?

0 uses your own provider: Anthropic, OpenAI, ChatGPT Codex, OpenRouter, Azure OpenAI, DeepSeek, Z.ai GLM, Moonshot Kimi, Alibaba Qwen, xAI Grok, OpenCode Zen and Together AI. Any OpenAI-compatible server, local or remote, also works. See [Models and keys](/models/).

## What can it scan?

Source repositories and pull request diffs ([Scan code](/scan-code/)), live web apps, APIs and MCP endpoints ([Scan web and APIs](/scan-web/)), and npm, pnpm, Cargo and PyPI dependencies ([Dependencies](/dependencies/)). It also tests AI agents and LLM endpoints for prompt injection and jailbreaks, and includes specialist workflows for binaries, cloud and Entra ID posture ([Specialist research](/research-workflows/)).

## How does it prove and fix a vulnerability?

A finding is a claim until verification reproduces it. A fix is accepted only when the patched code no longer reproduces the finding and your tests still pass. See [Verify and fix](/verify-and-fix/).

## What are persistent security agents (Agents)?

An Agent is a named agent with a scope, a tool-access level, a daily budget and memory. It runs threads on a schedule, when a GitHub pull request opens, or when you start it by hand. See [Agents](/agents/).

## Does it work in CI?

Yes. The GitHub Action runs 0 on your own runner with your own model key, applies a severity gate and writes JSON and SARIF reports. Other CI systems can run the CLI directly. See [CI](/ci/github-action/).

## Is it safe to point at my systems?

Only scan systems you own or are authorized to test. A [scope file](/scope/) limits live testing to the hosts you list, but it is not a sandbox. New Agents start paused, read-only and with production targets off.

## How do I get started?

Install with the one-line installer, run `0`, connect a model provider and start a thread in the browser app. The [Quickstart](/) has the steps, and [Models and keys](/models/) covers providers.
