# OpenClaw Plugin Issue Findings

Generated: deterministic
Status: PASS

## Triage Summary

| Metric               | Value |
| -------------------- | ----- |
| Issue findings       | 4     |
| P0                   | 0     |
| P1                   | 0     |
| Live issues          | 0     |
| Live P0 issues       | 0     |
| Compat gaps          | 0     |
| Deprecation warnings | 1     |
| Inspector gaps       | 3     |
| Upstream metadata    | 0     |
| Contract probes      | 4     |

## Triage Overview

| Class               | Count | P0 | Meaning                                                                                                         |
| ------------------- | ----- | -- | --------------------------------------------------------------------------------------------------------------- |
| live-issue          | 0     | 0  | Potential runtime breakage in the target OpenClaw/plugin pair. P0 only when it is not a deprecated compat seam. |
| compat-gap          | 0     | -  | Compatibility behavior is needed but missing from the target OpenClaw compat registry.                          |
| deprecation-warning | 1     | -  | Plugin uses a supported but deprecated compatibility seam; keep it wired while migration exists.                |
| inspector-gap       | 3     | -  | Plugin Inspector needs stronger capture/probe evidence before making contract judgments.                        |
| upstream-metadata   | 0     | -  | Plugin package or manifest metadata should improve upstream; not a target OpenClaw live break by itself.        |
| fixture-regression  | 0     | -  | Fixture no longer exposes an expected seam; investigate fixture pin or scanner drift.                           |

## P0 Live Issues

_none_

## Live Issues

_none_

## Compat Gaps

_none_

## Deprecation Warnings

- P2 **agentchat** `deprecation-warning` `core-compat-adapter`
  - **channel-env-vars**: agentchat: channelEnvVars legacy manifest metadata must stay covered
  - state: open · compat:deprecated · deprecated
  - evidence:
    - agentchat

## Inspector Proof Gaps

- P2 **agentchat** `inspector-gap` `inspector-follow-up`
  - **channel-contract-probe**: agentchat: channel runtime needs envelope/config probes
  - state: open · compat:none
  - evidence:
    - defineChannelPluginEntry @ src/channel.ts:351

- P2 **agentchat** `inspector-gap` `inspector-follow-up`
  - **package-build-artifact-entrypoint**: agentchat: cold import requires package build output
  - state: open · compat:none
  - evidence:
    - extension:./dist/index.js -> dist/index.js
    - setupEntry:./dist/setup-entry.js -> dist/setup-entry.js

- P2 **agentchat** `inspector-gap` `inspector-follow-up`
  - **package-dependency-install-required**: agentchat: cold import requires isolated dependency installation
  - state: open · compat:none
  - evidence:
    - @agentchatme/agentchat @ package.json
    - @sinclair/typebox @ package.json
    - pino @ package.json
    - ws @ package.json
    - zod @ package.json
    - openclaw @ package.json

## Upstream Metadata Issues

_none_

## Issues

- P2 **agentchat** `inspector-gap` `inspector-follow-up`
  - **channel-contract-probe**: agentchat: channel runtime needs envelope/config probes
  - state: open · compat:none
  - evidence:
    - defineChannelPluginEntry @ src/channel.ts:351

- P2 **agentchat** `deprecation-warning` `core-compat-adapter`
  - **channel-env-vars**: agentchat: channelEnvVars legacy manifest metadata must stay covered
  - state: open · compat:deprecated · deprecated
  - evidence:
    - agentchat

- P2 **agentchat** `inspector-gap` `inspector-follow-up`
  - **package-build-artifact-entrypoint**: agentchat: cold import requires package build output
  - state: open · compat:none
  - evidence:
    - extension:./dist/index.js -> dist/index.js
    - setupEntry:./dist/setup-entry.js -> dist/setup-entry.js

- P2 **agentchat** `inspector-gap` `inspector-follow-up`
  - **package-dependency-install-required**: agentchat: cold import requires isolated dependency installation
  - state: open · compat:none
  - evidence:
    - @agentchatme/agentchat @ package.json
    - @sinclair/typebox @ package.json
    - pino @ package.json
    - ws @ package.json
    - zod @ package.json
    - openclaw @ package.json

## Contract Probe Backlog

- P2 **agentchat** `channel-runtime`
  - contract: Channel setup, message envelope, sender metadata, and config schema remain stable.
  - id: `channel.runtime.envelope-config-metadata:agentchat`
  - evidence:
    - defineChannelPluginEntry @ src/channel.ts:351

- P2 **agentchat** `manifest-loader`
  - contract: Legacy channel env metadata continues to map into channel setup/help surfaces.
  - id: `manifest.compat.channel-env-vars:agentchat`
  - evidence:
    - agentchat

- P2 **agentchat** `package-loader`
  - contract: Inspector can build or resolve source aliases before cold importing package entrypoints.
  - id: `package.entrypoint.build-before-cold-import:agentchat`
  - evidence:
    - extension:./dist/index.js -> dist/index.js
    - setupEntry:./dist/setup-entry.js -> dist/setup-entry.js

- P2 **agentchat** `package-loader`
  - contract: Inspector installs package dependencies in an isolated workspace before cold import.
  - id: `package.entrypoint.isolated-dependency-install:agentchat`
  - evidence:
    - @agentchatme/agentchat @ package.json
    - @sinclair/typebox @ package.json
    - pino @ package.json
    - ws @ package.json
    - zod @ package.json
    - openclaw @ package.json
