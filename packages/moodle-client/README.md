# @ehub/moodle-client

Typed, sanitized client for Moodle REST web services and pluginfile downloads.

Moodle-side setup (restricted external service, service account, token) is documented in
[`docs/moodle-setup.md`](../../docs/moodle-setup.md).

## Usage

```ts
import { createMoodleServices, loadMoodleSettings } from '@ehub/moodle-client';

const { client, downloader } = createMoodleServices(loadMoodleSettings(), { logger });

const site = await client.getSiteInfo();
const sections = await client.getCourseContents(12);
const file = await downloader.download(sections[0].modules[0].contents[0].fileurl);
// file.sourceUrl / file.finalUrl are token-free; file.bytes holds the content.
```

## Components

| Interface              | Implementation             | Responsibility                                                      |
| ---------------------- | -------------------------- | ------------------------------------------------------------------- |
| `MoodleTransport`      | `HttpMoodleTransport`      | POST to `/webservice/rest/server.php`, retries, exception detection |
| `MoodleClient`         | `DefaultMoodleClient`      | Input validation and a Zod schema for every response                |
| `MoodleFileDownloader` | `HttpMoodleFileDownloader` | pluginfile-only downloads with host allowlist and limits            |

Every external dependency (`fetch`, logger, sleep, random) is injectable; tests never contact a
real server.

## Supported functions

`core_webservice_get_site_info`, `core_course_get_courses`, `core_course_get_contents`,
`core_enrol_get_enrolled_users`, `core_enrol_get_users_courses`, `core_user_get_users_by_field`.

Response schemas declare only the fields the application needs; undeclared fields (including
personal profile data) are stripped. Malformed responses raise `MoodleValidationError` with
`code: 'response_schema_mismatch'` and the failing field paths (never values).

## Errors

All errors extend `MoodleError` and expose `category`, `code`, `retryable`, `httpStatus`,
`moodleErrorCode`, `functionName` and `networkCode`. None has a `cause`.

| Class                       | Raised for                                                                      | Retried        |
| --------------------------- | ------------------------------------------------------------------------------- | -------------- |
| `MoodleAuthenticationError` | HTTP 401; `invalidtoken`, `invalidtimedtoken`, `invalidiptoken`; login redirect | No             |
| `MoodleAuthorizationError`  | HTTP 403; `accessexception`, `nopermissions`, `requireloginerror`               | No             |
| `MoodleRateLimitError`      | HTTP 429                                                                        | Yes            |
| `MoodleValidationError`     | Bad input, HTTP 400/404/413…, `invalidparameter`, schema mismatch, size limits  | No             |
| `MoodleTransportError`      | HTTP 408/500/502/503/504, network errors, timeouts, unsafe redirects            | Transient only |
| `MoodleApiError`            | Other Moodle exceptions, HTML or invalid JSON responses                         | No             |

## Retry policy

Up to `MOODLE_MAX_RETRIES` (default 3) retries with exponential backoff and full jitter
(base 500 ms, cap 10 s) for HTTP 408, 429, 500, 502, 503, 504, connection resets
(`ECONNRESET`, undici `UND_ERR_SOCKET`) and temporary DNS failure (`EAI_AGAIN`). A
`Retry-After` header is honoured up to 30 s; longer requests surface the error instead.
Client-side timeouts are not retried, to avoid piling load onto a struggling server.

## Download safety

- Only `https://<moodle host>/<prefix>/pluginfile.php/…` and `…/webservice/pluginfile.php/…`
  URLs are accepted; anything else is rejected before a request is made.
- Plain `pluginfile.php` URLs are rewritten to `webservice/pluginfile.php` for token access.
- Redirects are followed manually (max 3), only to the Moodle host or
  `additionalRedirectHosts`, only over https, never to the login page, and never with the token.
- `MOODLE_MAX_DOWNLOAD_BYTES` (default 100 MB) is enforced from Content-Length and while
  streaming; `MOODLE_DOWNLOAD_TIMEOUT_MS` (default 120 s) covers the whole download.
- The returned `contentType` is the server's claim only; extraction (phase 4) must detect the
  real type.
