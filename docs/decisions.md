# Foundation decisions (phase 1)

Short records of choices made in phase 1 that later phases depend on.

## Toolchain versions are pinned below the newest releases

| Tool        | Pinned   | Newest at time of writing | Reason                                                  |
| ----------- | -------- | ------------------------- | ------------------------------------------------------- |
| TypeScript  | `~6.0.3` | 7.0.x                     | `typescript-eslint` 8.x supports TypeScript `<6.1` only |
| Vitest      | `^4.1`   | 5.0.x                     | Major upgrade deferred; 4.x supports Node 22            |
| @types/node | `^22`    | 26.x                      | Type definitions match the oldest supported runtime     |

Revisit when `typescript-eslint` supports TypeScript 7.

## Minimum Node.js is 22.13 (raised in phase 4)

Phase 1 started on Node 20.19. Phase 4 raised the minimum to **22.13** because the PDF parser
(`pdfjs-dist`) requires it from version 5 onward, and the last Node-20-compatible release
(4.10, January 2025) no longer receives security fixes — unacceptable for a component that
parses untrusted documents. Node 20 itself reached end of life in April 2026. This still
satisfies the project rule "Node.js 20 or later". Hosting (phase 19) must run Node 22 LTS or
newer.

## Workspace packages resolve to source during development

Each package exports a custom `@ehub/source` condition pointing at `src/index.ts`, enabled
through `customConditions` in `tsconfig.base.json`, `tsx --conditions=@ehub/source` and the
Vitest resolver. Type checking, tests and CLI runs therefore never need a prior build. Built
output (`tsc -b`, project references) resolves the normal `default` condition to `dist/`.

## A small in-house logger instead of pino

Redaction must apply to keys at any depth, case- and separator-insensitively, plus value
patterns (Moodle `wstoken=` URLs, bearer tokens) and registered secret values. pino's
path-based `redact` cannot express "any key named like `token` at any depth", so wrapping it
would have meant reimplementing redaction anyway. The `Logger` interface keeps the
implementation replaceable; phase 16 adds OpenTelemetry export behind it.

## Configuration is validated per feature group

`runtime`, `moodle`, `azureSearch`, `azureOpenAI`, `azureIdentity` and `observability` are
separate schemas, so each command validates only what it uses and health reports can show which
groups are missing. `applicationConfigSchema` validates everything for production start-up.
Production-only rules (https) are applied by `defineConfigSchema` to every group.

## CLI output contract

stdout carries only the command result (JSON for machine use); logs go to stderr. Unexpected
errors are logged through the redacting logger and reported as `{ "status": "error",
"correlationId": … }` with exit code 1.
