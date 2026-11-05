// @ts-check
/*
 * E-Hub Assistant administration page. Plain DOM code: every value from the server is set as
 * text (textContent or attribute values), never parsed as HTML. The server checks every
 * permission; this page only hides what the signed-in user cannot use.
 */

/** @typedef {{ mode: 'msal', clientId: string, authority: string, scopes: string[] } | { mode: 'dev-mock', mockUserId: string } | { mode: 'unavailable' }} ClientConfig */
/** @typedef {{ objectId: string, displayName: string | null, roles: string[], permissions: string[], mock: boolean }} Me */
/** @typedef {Record<string, unknown>} Json */

class ApiError extends Error {
  /**
   * @param {number} status
   * @param {string} code
   * @param {string} message
   * @param {string | null} correlationId
   */
  constructor(status, code, message, correlationId) {
    super(message);
    this.status = status;
    this.code = code;
    this.correlationId = correlationId;
  }
}

const PAGES = /** @type {const} */ ([
  { id: 'dashboard', title: 'Dashboard', permission: 'view:content' },
  { id: 'courses', title: 'Courses', permission: 'view:content' },
  { id: 'jobs', title: 'Sync jobs', permission: 'view:content' },
  { id: 'failures', title: 'Failures', permission: 'view:content' },
  { id: 'identity', title: 'Identity mappings', permission: 'view:identity' },
  { id: 'configuration', title: 'Configuration', permission: 'view:configuration' },
  { id: 'audit', title: 'Audit trail', permission: 'view:audit' },
]);

/** @param {string} id @returns {HTMLElement} */
function byId(id) {
  const element = document.getElementById(id);
  if (element === null) {
    throw new Error(`Missing #${id}`);
  }
  return element;
}

/**
 * Creates an element with attributes and children. Strings become text nodes.
 * @param {string} tag
 * @param {Record<string, string | boolean>} [attributes]
 * @param {(Node | string | null | undefined)[]} [children]
 * @returns {HTMLElement}
 */
function el(tag, attributes = {}, children = []) {
  const element = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) {
    if (value === false) {
      continue;
    }
    element.setAttribute(name, value === true ? '' : value);
  }
  for (const child of children) {
    if (child === null || child === undefined) {
      continue;
    }
    element.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return element;
}

/** @param {unknown} value @returns {string} */
function text(value) {
  if (value === null || value === undefined || value === '') {
    return '—';
  }
  if (Array.isArray(value)) {
    return value.length === 0 ? '—' : value.map((item) => String(item)).join(', ');
  }
  return String(value);
}

/** @param {unknown} value @returns {string} */
function when(value) {
  if (typeof value !== 'string') {
    return '—';
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

/** @param {unknown} value @returns {Json} */
function obj(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? /** @type {Json} */ (value)
    : {};
}

/** @param {unknown} value @returns {Json[]} */
function list(value) {
  return Array.isArray(value) ? value.map(obj) : [];
}

/**
 * A data table with a caption and column headers.
 * @param {string} caption
 * @param {string[]} headings
 * @param {(Node | string)[][]} rows
 * @param {string} empty
 */
function table(caption, headings, rows, empty) {
  if (rows.length === 0) {
    return el('p', { class: 'muted' }, [empty]);
  }
  return el('table', {}, [
    el('caption', {}, [caption]),
    el('thead', {}, [
      el(
        'tr',
        {},
        headings.map((heading) => el('th', { scope: 'col' }, [heading])),
      ),
    ]),
    el(
      'tbody',
      {},
      rows.map((cells) =>
        el(
          'tr',
          {},
          cells.map((cell) => el('td', {}, [cell])),
        ),
      ),
    ),
  ]);
}

/**
 * Definition-list cards for headline numbers.
 * @param {[string, string][]} items
 */
function cards(items) {
  return el(
    'dl',
    { class: 'cards' },
    items.map(([label, value]) => el('div', {}, [el('dt', {}, [label]), el('dd', {}, [value])])),
  );
}

// ------------------------------------------------------------------ messages

/** @param {string} message */
function announce(message) {
  byId('status').textContent = message;
}

/** @param {unknown} error */
function showError(error) {
  const box = byId('error');
  box.replaceChildren();
  if (error instanceof ApiError) {
    box.append(
      el('p', {}, [error.message]),
      el('p', { class: 'muted' }, [
        `Code: ${error.code}${error.correlationId === null ? '' : ` · Reference: ${error.correlationId}`}`,
      ]),
    );
  } else {
    box.append(el('p', {}, ['Something went wrong. Reload the page and try again.']));
  }
  box.hidden = false;
}

function clearMessages() {
  byId('error').hidden = true;
  byId('error').replaceChildren();
  announce('');
}

/**
 * Asks for confirmation in a modal dialog; resolves true only on an explicit "Confirm".
 * @param {string} title
 * @param {string} message
 * @param {string} confirmLabel
 * @returns {Promise<boolean>}
 */
function confirmAction(title, message, confirmLabel) {
  const dialog = /** @type {HTMLDialogElement} */ (byId('confirm-dialog'));
  byId('confirm-title').textContent = title;
  byId('confirm-text').textContent = message;
  byId('confirm-ok').textContent = confirmLabel;
  return new Promise((resolve) => {
    dialog.addEventListener(
      'close',
      () => {
        resolve(dialog.returnValue === 'confirm');
      },
      { once: true },
    );
    dialog.returnValue = '';
    dialog.showModal();
  });
}

// ------------------------------------------------------------------ sign-in and API

/** @type {() => Promise<Record<string, string>>} */
let authHeaders = () => Promise.resolve({});

/**
 * @param {ClientConfig} config
 * @returns {Promise<{ signedIn: boolean, signIn?: () => void, signOut?: () => void }>}
 */
async function setUpSignIn(config) {
  if (config.mode === 'dev-mock') {
    const banner = byId('mode-banner');
    banner.textContent =
      'Development mode: signed in as the mock identity. Not for production use.';
    banner.hidden = false;
    authHeaders = () => Promise.resolve({ 'x-ehub-mock-identity': config.mockUserId });
    return { signedIn: true };
  }
  if (config.mode !== 'msal' || typeof msal === 'undefined') {
    return { signedIn: false };
  }
  const client = new msal.PublicClientApplication({
    auth: {
      clientId: config.clientId,
      authority: config.authority,
      redirectUri: `${window.location.origin}/admin/`,
    },
    cache: { cacheLocation: 'sessionStorage' },
  });
  await client.initialize();
  const redirect = await client.handleRedirectPromise();
  const account = redirect?.account ?? client.getAllAccounts()[0];
  const signIn = () => {
    void client.loginRedirect({ scopes: config.scopes });
  };
  if (account === undefined || account === null) {
    return { signedIn: false, signIn };
  }
  client.setActiveAccount(account);
  authHeaders = async () => {
    try {
      const result = await client.acquireTokenSilent({ scopes: config.scopes, account });
      return { authorization: `Bearer ${result.accessToken}` };
    } catch (error) {
      if (error instanceof msal.InteractionRequiredAuthError) {
        await client.acquireTokenRedirect({ scopes: config.scopes });
      }
      throw error;
    }
  };
  return {
    signedIn: true,
    signOut: () => {
      void client.logoutRedirect({ account });
    },
  };
}

/**
 * @param {string} path
 * @param {Json} [body]
 * @returns {Promise<Json>}
 */
async function api(path, body) {
  const headers = { ...(await authHeaders()), accept: 'application/json' };
  const response = await fetch(`/admin/api/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? headers : { ...headers, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    credentials: 'omit',
    cache: 'no-store',
  });
  /** @type {unknown} */
  let payload;
  try {
    payload = await response.json();
  } catch {
    payload = {};
  }
  const data = obj(payload);
  if (!response.ok) {
    const error = obj(data['error']);
    throw new ApiError(
      response.status,
      typeof error['code'] === 'string' ? error['code'] : 'error',
      typeof error['message'] === 'string' ? error['message'] : 'The request failed.',
      typeof data['correlationId'] === 'string' ? data['correlationId'] : null,
    );
  }
  return data;
}

// ------------------------------------------------------------------ actions

/** @type {Set<string>} */
let permissions = new Set();

/**
 * Runs an action from a button, with status and error messages.
 * @param {HTMLButtonElement} button
 * @param {() => Promise<Json>} run
 * @param {(result: Json) => string} describe
 */
async function act(button, run, describe) {
  clearMessages();
  button.disabled = true;
  try {
    const result = await run();
    announce(describe(result));
    await render();
  } catch (error) {
    showError(error);
  } finally {
    button.disabled = false;
  }
}

/**
 * A button that is shown only with the permission (the server checks it anyway).
 * @param {string} label
 * @param {string} permission
 * @param {(button: HTMLButtonElement) => void} onClick
 * @param {string} [className]
 */
function actionButton(label, permission, onClick, className) {
  if (!permissions.has(permission)) {
    return '';
  }
  const button = /** @type {HTMLButtonElement} */ (
    el('button', { type: 'button', ...(className === undefined ? {} : { class: className }) }, [
      label,
    ])
  );
  button.addEventListener('click', () => {
    onClick(button);
  });
  return button;
}

/** @param {Json} result */
function started(result) {
  return `Job started (${text(result['jobId'])}). Its progress appears under Sync jobs.`;
}

// ------------------------------------------------------------------ pages

/** @type {Record<string, () => Promise<Node[]>>} */
const RENDERERS = {
  async dashboard() {
    const data = await api('dashboard');
    const resources = obj(data['resources']);
    const failures = obj(resources['failures']);
    const answers = obj(data['answers']);
    const feedback = obj(data['feedback']);
    const courses = obj(data['courses']);
    const last = obj(data['lastSuccessfulSync']);
    const runner = obj(data['runner']);
    const active = list(data['activeSyncs']);
    return [
      cards([
        [
          'Last successful sync',
          data['lastSuccessfulSync'] === null ? 'Never' : when(last['finishedAt']),
        ],
        [
          'Active sync',
          active.length === 0 && runner['busy'] !== true
            ? 'None'
            : `${String(active.length)} running${active.some((job) => job['possiblyStale'] === true) ? ' (one may be stale)' : ''}`,
        ],
        [
          'Courses included',
          courses['selection'] === 'all' ? 'All visible courses' : text(courses['included']),
        ],
        ['Indexed resources', text(resources['indexed'])],
        ['Skipped resources', text(resources['skipped'])],
        [
          'Processing failures',
          `${String(Number(failures['failed'] ?? 0) + Number(failures['deadLetter'] ?? 0) + Number(failures['quarantined'] ?? 0))} (failed ${text(failures['failed'])}, dead-letter ${text(failures['deadLetter'])}, quarantined ${text(failures['quarantined'])})`,
        ],
        ['Stale or deleted resources', text(resources['removed'])],
        [
          `Insufficient evidence (${text(answers['days'])} days)`,
          `${text(answers['insufficientEvidence'])} of ${String(Number(answers['answered'] ?? 0) + Number(answers['insufficientEvidence'] ?? 0) + Number(answers['failed'] ?? 0))} questions`,
        ],
        [
          `Feedback (${text(feedback['days'])} days)`,
          `${text(feedback['useful'])} useful, ${text(feedback['notUseful'])} not useful`,
        ],
      ]),
      el('p', {}, [
        actionButton('Run incremental sync', 'action:sync', (button) => {
          void act(button, () => api('actions/incremental-sync', {}), started);
        }),
      ]),
    ];
  },

  async courses() {
    const data = await api('courses');
    const rows = list(data['courses']).map((course) => [
      text(course['courseId']),
      text(course['name']),
      course['inclusion'] === 'included' ? 'Included' : 'Not selected',
      when(course['lastIndexedAt']),
      text(course['resourceCount']),
      text(course['failureCount']),
      course['canReindex'] === true
        ? actionButton(
            'Re-index',
            'action:reindex',
            (button) => {
              void (async () => {
                const id = Number(course['courseId']);
                if (
                  !(await confirmAction(
                    'Re-index course',
                    `Re-index course ${String(id)}? Every resource is downloaded, extracted and embedded again. This can take a while and uses embedding quota.`,
                    'Re-index',
                  ))
                ) {
                  announce('Re-index cancelled.');
                  return;
                }
                await act(
                  button,
                  () => api('actions/reindex', { courseId: id, confirm: true }),
                  started,
                );
              })();
            },
            'danger',
          )
        : '',
    ]);
    return [
      data['namesAvailable'] === false
        ? el('p', { class: 'muted' }, ['Course names could not be read from Moodle.'])
        : null,
      table(
        'Courses',
        [
          'Moodle course ID',
          'Name',
          'Inclusion',
          'Last indexed',
          'Resources',
          'Failures',
          'Action',
        ],
        rows,
        'No courses yet.',
      ),
    ].filter((node) => node !== null);
  },

  async jobs() {
    const data = await api('jobs');
    const runner = obj(data['runner']);
    const current = obj(runner['current']);
    const rows = list(data['jobs']).map((job) => {
      const summary = obj(job['summary']);
      return [
        text(job['jobId']),
        text(job['jobType']),
        `${text(job['status'])}${job['possiblyStale'] === true ? ' (possibly stale)' : ''}`,
        when(job['startedAt']),
        when(job['finishedAt']),
        `${text(summary['courses'])} courses; processed ${text(summary['processed'])}, updated ${text(summary['updated'])}, skipped ${text(summary['skipped'])}, removed ${text(summary['removed'])}, failed ${text(summary['failed'])}${summary['failureCategory'] === null ? '' : `; stopped: ${text(summary['failureCategory'])}`}`,
        text(job['correlationId']),
      ];
    });
    return [
      el('p', {}, [
        runner['busy'] === true
          ? `A manual ${text(current['kind'])} job is running (${text(current['jobId'])}).`
          : 'No manual job is running.',
      ]),
      table(
        'Recent sync jobs',
        ['Job ID', 'Type', 'Status', 'Started', 'Finished', 'Summary', 'Correlation ID'],
        rows,
        'No sync jobs recorded yet.',
      ),
    ];
  },

  async failures() {
    const data = await api('failures');
    const rows = list(data['failures']).map((failure) => [
      `${text(failure['courseId'])}${failure['courseName'] === null ? '' : ` · ${text(failure['courseName'])}`}`,
      text(failure['resourceId']),
      text(failure['stage']),
      `${text(failure['category'])} (${text(failure['status'])})`,
      text(failure['retryCount']),
      failure['canRetry'] === true
        ? actionButton('Retry', 'action:retry', (button) => {
            void act(
              button,
              () =>
                api('actions/retry', {
                  courseId: Number(failure['courseId']),
                  resourceId: String(failure['resourceId']),
                }),
              started,
            );
          })
        : '',
    ]);
    return [
      table(
        'Resources that failed processing',
        ['Course', 'Resource', 'Stage', 'Error category', 'Retries', 'Action'],
        rows,
        'No failures.',
      ),
    ];
  },

  async identity() {
    const data = await api('identity');
    if (data['available'] !== true) {
      return [el('p', {}, ['Moodle identity mapping is not configured on this server.'])];
    }
    const nodes = [];
    if (permissions.has('action:identity')) {
      const objectId = /** @type {HTMLInputElement} */ (
        el('input', {
          id: 'map-oid',
          name: 'entraObjectId',
          required: true,
          autocomplete: 'off',
          pattern: '[0-9a-fA-F-]{36}',
        })
      );
      const moodleId = /** @type {HTMLInputElement} */ (
        el('input', {
          id: 'map-moodle',
          name: 'moodleUserId',
          required: true,
          inputmode: 'numeric',
          pattern: '[1-9][0-9]{0,9}',
        })
      );
      const reference = /** @type {HTMLInputElement} */ (
        el('input', { id: 'map-ref', name: 'reference', autocomplete: 'off', maxlength: '100' })
      );
      const submit = /** @type {HTMLButtonElement} */ (
        el('button', { type: 'submit' }, ['Approve mapping'])
      );
      const form = /** @type {HTMLFormElement} */ (
        el('form', { class: 'inline', 'aria-labelledby': 'map-heading' }, [
          el('label', { for: 'map-oid' }, ['Entra object ID', objectId]),
          el('label', { for: 'map-moodle' }, ['Moodle user ID', moodleId]),
          el('label', { for: 'map-ref' }, ['Reference (e.g. ticket)', reference]),
          submit,
        ])
      );
      form.addEventListener('submit', (event) => {
        event.preventDefault();
        void (async () => {
          if (!form.reportValidity()) {
            return;
          }
          if (
            !(await confirmAction(
              'Approve identity mapping',
              `Link Entra user ${objectId.value} to Moodle user ${moodleId.value}? This overrides automatic matching: the user will see that Moodle account's courses.`,
              'Approve',
            ))
          ) {
            announce('Mapping cancelled.');
            return;
          }
          await act(
            submit,
            () =>
              api('identity/mappings', {
                entraObjectId: objectId.value.trim(),
                moodleUserId: Number(moodleId.value),
                ...(reference.value.trim() === '' ? {} : { reference: reference.value.trim() }),
                confirm: true,
              }),
            () => 'Mapping approved.',
          );
        })();
      });
      nodes.push(el('h2', { id: 'map-heading' }, ['Approve an override']), form);
    }
    const mappings = list(data['mappings']).map((mapping) => [
      text(mapping['entraObjectId']),
      text(mapping['moodleUserId']),
      text(mapping['method']),
      el('span', { class: 'badge' }, [text(mapping['status'])]),
      `${when(mapping['approvedAt'])} by ${text(mapping['approvedBy'])}${mapping['reference'] === null ? '' : ` (${text(mapping['reference'])})`}`,
      actionButton(
        'Remove',
        'action:identity',
        (button) => {
          void (async () => {
            const id = String(mapping['entraObjectId']);
            if (
              !(await confirmAction(
                'Remove mapping',
                `Remove the explicit mapping for ${id}? The user falls back to automatic matching.`,
                'Remove',
              ))
            ) {
              announce('Removal cancelled.');
              return;
            }
            await act(
              button,
              () => api('identity/mappings/remove', { entraObjectId: id, confirm: true }),
              () => 'Mapping removed.',
            );
          })();
        },
        'danger',
      ),
    ]);
    const failures = list(data['recentFailures']).map((failure) => [
      text(failure['entraObjectId']),
      '—',
      text(failure['method']),
      el('span', { class: 'badge' }, [`denied: ${text(failure['reason'])}`]),
      `${when(failure['at'])}${failure['candidates'] === null ? '' : ` · ${text(failure['candidates'])} candidates`}${failure['accountType'] === null ? '' : ` · ${text(failure['accountType'])}`}`,
      actionButton('Refresh access', 'action:enrolment-refresh', (button) => {
        void act(
          button,
          () =>
            api('actions/enrolment-refresh', {
              scope: 'user',
              entraObjectId: String(failure['entraObjectId']),
            }),
          () => 'Cached access cleared for that user.',
        );
      }),
    ]);
    const headings = [
      'Entra object ID',
      'Moodle user ID',
      'Mapping method',
      'Status',
      'Details',
      'Action',
    ];
    nodes.push(
      table('Explicit mappings', headings, mappings, 'No explicit mappings.'),
      table('Recent mapping failures', headings, failures, 'No mapping failures recorded.'),
      el('p', { class: 'muted' }, [`${text(data['observedUsers'])} users have signed in.`]),
      el('p', {}, [
        actionButton(
          'Refresh everyone’s course access',
          'action:enrolment-refresh',
          (button) => {
            void (async () => {
              if (
                !(await confirmAction(
                  'Refresh all course access',
                  'Clear the cached course access of every user? Each user’s next question re-reads Moodle.',
                  'Refresh all',
                ))
              ) {
                announce('Refresh cancelled.');
                return;
              }
              await act(
                button,
                () => api('actions/enrolment-refresh', { scope: 'all', confirm: true }),
                () => 'Cached course access cleared for everyone.',
              );
            })();
          },
          'danger',
        ),
      ]),
    );
    return nodes;
  },

  async configuration() {
    const data = await api('configuration');
    return [
      el('p', { class: 'muted' }, [
        'Read-only. Settings change in the application configuration; secrets are never shown.',
      ]),
      ...list(data['sections']).map((section) =>
        section['configured'] === false && list(section['settings']).length === 0
          ? el('p', {}, [`${text(section['title'])}: not configured.`])
          : table(
              text(section['title']),
              ['Setting', 'Value'],
              list(section['settings']).map((setting) => [
                text(setting['name']),
                text(setting['value']),
              ]),
              'No settings.',
            ),
      ),
    ];
  },

  async audit() {
    const data = await api('audit');
    const rows = list(data['events']).map((event) => {
      const actor = obj(event['actor']);
      const target = obj(event['target']);
      return [
        when(event['at']),
        text(event['action']),
        `${text(event['outcome'])}${event['reason'] === undefined ? '' : ` (${text(event['reason'])})`}`,
        `${text(actor['objectId'])} [${text(actor['roles'])}]`,
        Object.entries(target)
          .map(([key, value]) => `${key}: ${text(value)}`)
          .join(', ') || '—',
        text(event['correlationId']),
      ];
    });
    return [
      table(
        `Administrative actions (last ${text(data['days'])} days)`,
        ['Time', 'Action', 'Outcome', 'Administrator', 'Target', 'Correlation ID'],
        rows,
        'No administrative actions recorded.',
      ),
    ];
  },
};

// ------------------------------------------------------------------ navigation

/** @type {Me | null} */
let me = null;

function currentPage() {
  const id = window.location.hash.replace(/^#/, '');
  const allowed = PAGES.filter((page) => permissions.has(page.permission));
  return allowed.find((page) => page.id === id) ?? allowed[0];
}

function renderNav() {
  const nav = byId('nav');
  const page = currentPage();
  nav.replaceChildren(
    ...PAGES.filter((entry) => permissions.has(entry.permission)).map((entry) =>
      el('li', {}, [
        el(
          'a',
          { href: `#${entry.id}`, ...(entry.id === page?.id ? { 'aria-current': 'page' } : {}) },
          [entry.title],
        ),
      ]),
    ),
  );
}

async function render() {
  const page = currentPage();
  const title = byId('page-title');
  const container = byId('page');
  renderNav();
  if (page === undefined) {
    title.textContent = 'No access';
    container.replaceChildren(
      el('p', {}, [
        'Your account has no administration role. Ask an application administrator to assign EHub.ContentAdministrator, EHub.ApplicationAdministrator or EHub.Auditor.',
      ]),
    );
    return;
  }
  title.textContent = page.title;
  document.title = `${page.title} · E-Hub Assistant administration`;
  container.setAttribute('aria-busy', 'true');
  try {
    const renderer = RENDERERS[page.id];
    if (renderer === undefined) {
      return;
    }
    container.replaceChildren(...(await renderer()));
  } catch (error) {
    container.replaceChildren();
    showError(error);
  } finally {
    container.removeAttribute('aria-busy');
  }
}

async function start() {
  const account = byId('account');
  let config;
  try {
    const response = await fetch('/admin/api/client-config', {
      credentials: 'omit',
      cache: 'no-store',
    });
    config = /** @type {ClientConfig} */ (await response.json());
  } catch {
    showError(null);
    return;
  }
  const session = await setUpSignIn(config);
  if (!session.signedIn) {
    byId('page-title').textContent = 'Sign in';
    if (session.signIn === undefined) {
      byId('page').replaceChildren(
        el('p', {}, ['Sign-in is not configured for the administration area.']),
      );
      return;
    }
    const button = el('button', { type: 'button' }, ['Sign in with Microsoft']);
    button.addEventListener('click', session.signIn);
    byId('page').replaceChildren(el('p', {}, ['Sign in with your Skin Renewal account.']), button);
    return;
  }
  try {
    const data = await api('me');
    me = {
      objectId: String(data['objectId']),
      displayName: typeof data['displayName'] === 'string' ? data['displayName'] : null,
      roles: Array.isArray(data['roles']) ? data['roles'].map(String) : [],
      permissions: Array.isArray(data['permissions']) ? data['permissions'].map(String) : [],
      mock: data['mock'] === true,
    };
  } catch (error) {
    byId('page-title').textContent = 'Not signed in';
    showError(error);
    return;
  }
  permissions = new Set(me.permissions);
  account.replaceChildren(
    `${me.displayName ?? me.objectId} · ${me.roles.length === 0 ? 'no administration role' : me.roles.join(', ')}`,
  );
  if (session.signOut !== undefined) {
    const out = el('button', { type: 'button', class: 'secondary' }, ['Sign out']);
    out.addEventListener('click', session.signOut);
    account.append(' ', out);
  }
  window.addEventListener('hashchange', () => {
    clearMessages();
    void render().then(() => {
      byId('page-title').focus();
    });
  });
  await render();
}

void start();
