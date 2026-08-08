/**
 * Read-only inspector shell.
 *
 * The page contains no data: every `/inspector/api/*` call is made from the
 * browser with the operator's Portico API key, so tenant-scoped responses
 * are fetched on demand and never rendered into the shell itself.
 */

export const INSPECTOR_PAGE = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>MCP Portico inspector</title>
    <style>
      :root {
        color-scheme: dark;
        --bg: #0f1115;
        --panel: #171a21;
        --border: #2a2f3a;
        --text: #d7dce4;
        --muted: #8b93a1;
        --accent: #5b8cff;
        --ok: #3fb950;
        --bad: #f85149;
        --warn: #d29922;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        background: var(--bg);
        color: var(--text);
        font: 14px/1.5 ui-sans-serif, system-ui, sans-serif;
      }
      header {
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 14px 20px;
        border-bottom: 1px solid var(--border);
        background: var(--panel);
      }
      header h1 { font-size: 16px; margin: 0; }
      header .meta { color: var(--muted); font-size: 12px; }
      main { padding: 20px; max-width: 1100px; margin: 0 auto; }
      .authbar {
        display: flex;
        gap: 8px;
        margin-bottom: 18px;
      }
      input[type="password"] {
        flex: 1;
        max-width: 460px;
        background: var(--panel);
        border: 1px solid var(--border);
        border-radius: 6px;
        color: var(--text);
        padding: 8px 10px;
      }
      button {
        background: var(--accent);
        border: 0;
        border-radius: 6px;
        color: #fff;
        padding: 8px 16px;
        cursor: pointer;
        font-weight: 600;
      }
      button.secondary { background: #303747; }
      .cards {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
        gap: 12px;
        margin-bottom: 18px;
      }
      .card {
        background: var(--panel);
        border: 1px solid var(--border);
        border-radius: 8px;
        padding: 12px 14px;
      }
      .card .label { color: var(--muted); font-size: 12px; }
      .card .value { font-size: 22px; font-weight: 700; margin-top: 4px; }
      .card .value.ok { color: var(--ok); }
      .card .value.bad { color: var(--bad); }
      table {
        width: 100%;
        border-collapse: collapse;
        background: var(--panel);
        border: 1px solid var(--border);
        border-radius: 8px;
        overflow: hidden;
        margin-bottom: 18px;
      }
      th, td {
        text-align: left;
        padding: 8px 10px;
        border-bottom: 1px solid var(--border);
        vertical-align: top;
      }
      th { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: 0.04em; }
      tr.clickable { cursor: pointer; }
      tr.clickable:hover td { background: #1c212b; }
      .pill {
        display: inline-block;
        border-radius: 999px;
        padding: 1px 8px;
        font-size: 11px;
        border: 1px solid var(--border);
      }
      .pill.ok { color: var(--ok); border-color: var(--ok); }
      .pill.bad { color: var(--bad); border-color: var(--bad); }
      .pill.warn { color: var(--warn); border-color: var(--warn); }
      .pill.muted { color: var(--muted); }
      code {
        background: #0b0d11;
        border: 1px solid var(--border);
        border-radius: 4px;
        padding: 1px 5px;
        font-size: 12px;
      }
      .muted { color: var(--muted); }
      h2 { font-size: 14px; margin: 22px 0 10px; }
      #error { color: var(--bad); margin: 10px 0; }
      #detail { display: none; }
    </style>
  </head>
  <body>
    <header>
      <h1>MCP Portico inspector</h1>
      <span class="meta" id="meta"></span>
    </header>
    <main>
      <div class="authbar">
        <input
          id="token"
          type="password"
          placeholder="Portico API key (mpp_...)"
          autocomplete="off"
        />
        <button id="load">Load</button>
      </div>
      <div id="error"></div>
      <section id="overview"></section>
      <section id="connections"></section>
      <section id="detail"></section>
      <section id="audit"></section>
    </main>
    <script>
      'use strict';
      var token = '';

      function el(tag, className, text) {
        var node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined) node.textContent = text;
        return node;
      }

      function api(path) {
        return fetch(path, {
          headers: token ? { Authorization: 'Bearer ' + token } : {},
        }).then(function (response) {
          return response.json().then(function (body) {
            if (!response.ok) {
              throw new Error(
                (body && body.error && body.error.message) || 'Request failed',
              );
            }
            return body;
          });
        });
      }

      function post(path) {
        return fetch(path, {
          method: 'POST',
          headers: token ? { Authorization: 'Bearer ' + token } : {},
        }).then(function (response) {
          return response.json().then(function (body) {
            if (!response.ok) {
              throw new Error(
                (body && body.error && body.error.message) || 'Request failed',
              );
            }
            return body;
          });
        });
      }

      function pill(text, kind) {
        return el('span', 'pill ' + (kind || 'muted'), text);
      }

      function table(headers, rows) {
        var tableEl = el('table');
        var thead = el('thead');
        var headRow = el('tr');
        headers.forEach(function (header) {
          headRow.appendChild(el('th', null, header));
        });
        thead.appendChild(headRow);
        tableEl.appendChild(thead);
        var tbody = el('tbody');
        rows.forEach(function (row) {
          var tr = el('tr');
          row.forEach(function (cell) {
            var td = el('td');
            if (typeof cell === 'string') {
              td.textContent = cell;
            } else if (cell instanceof HTMLElement) {
              td.appendChild(cell);
            }
            tr.appendChild(td);
          });
          tbody.appendChild(tr);
        });
        tableEl.appendChild(tbody);
        return tableEl;
      }

      function renderOverview(data) {
        var section = document.getElementById('overview');
        section.replaceChildren();
        section.appendChild(el('h2', null, 'Overview'));
        var cards = el('div', 'cards');
        [
          ['Tenant', data.tenant ? data.tenant.name : '-'],
          ['Principal', data.principal ? data.principal.id : '-'],
          ['Connections', String(data.summary.connections)],
          ['Operations', String(data.summary.operations)],
          ['Available', String(data.summary.available)],
          ['Unhealthy', String(data.summary.unhealthy), data.summary.unhealthy > 0 ? 'bad' : 'ok'],
        ].forEach(function (item) {
          var card = el('div', 'card');
          card.appendChild(el('div', 'label', item[0]));
          card.appendChild(el('div', 'value ' + (item[2] || ''), item[1]));
          cards.appendChild(card);
        });
        section.appendChild(cards);
      }

      function renderConnections(data) {
        var section = document.getElementById('connections');
        section.replaceChildren();
        section.appendChild(el('h2', null, 'Connections'));
        if (data.connections.length === 0) {
          section.appendChild(el('p', 'muted', 'No authorized connections.'));
          return;
        }
        var rows = data.connections.map(function (connection) {
          var status =
            connection.health && connection.health.status === 'unhealthy'
              ? pill('unhealthy', 'bad')
              : pill(connection.health ? 'healthy' : 'unknown', 'ok');
          return [
            connection.id,
            connection.backendId,
            connection.baseUrl,
            connection.authType || 'none',
            connection.catalog
              ? connection.catalog.apiId + ' ' + connection.catalog.version
              : '-',
            connection.catalog
              ? connection.catalog.available + '/' + connection.catalog.operations
              : '-',
            status,
          ];
        });
        var body = table(
          ['Id', 'Backend', 'Base URL', 'Auth', 'Catalog', 'Available', 'Health'],
          rows,
        );
        Array.prototype.forEach.call(body.querySelectorAll('tbody tr'), function (
          row,
          index,
        ) {
          row.classList.add('clickable');
          row.addEventListener('click', function () {
            loadDetail(data.connections[index].id);
          });
        });
        section.appendChild(body);
      }

      function renderDetail(data) {
        var section = document.getElementById('detail');
        section.replaceChildren();
        section.appendChild(el('h2', null, 'Connection: ' + data.connection.id));
        section.appendChild(
          el(
            'p',
            'muted',
            data.connection.backendId +
              ' - ' +
              data.connection.baseUrl +
              ' (auth ' +
              data.connection.authType +
              ')',
          ),
        );
        var cards = el('div', 'cards');
        [
          ['Health', data.health ? data.health.status : 'unknown'],
          ['Circuit', data.circuit || 'closed'],
          ['Concurrency', String(data.concurrency || 0)],
          ['Warnings', String(data.warnings || 0)],
        ].forEach(function (item) {
          var card = el('div', 'card');
          card.appendChild(el('div', 'label', item[0]));
          card.appendChild(el('div', 'value', item[1]));
          cards.appendChild(card);
        });
        section.appendChild(cards);

        if (data.operations && data.operations.length > 0) {
          section.appendChild(el('h2', null, 'Operations'));
          section.appendChild(
            table(
              ['Operation', 'Method', 'Path', 'Risk', 'State'],
              data.operations.map(function (operation) {
                var state = operation.available
                  ? operation.enabled
                    ? pill('available', 'ok')
                    : pill('disabled', 'warn')
                  : pill('unavailable', 'bad');
                return [
                  operation.id,
                  operation.method,
                  operation.path,
                  operation.risk,
                  state,
                ];
              }),
            ),
          );
        }

        if (data.audit && data.audit.length > 0) {
          section.appendChild(el('h2', null, 'Recent activity'));
          section.appendChild(
            table(
              ['Time', 'Action', 'Operation', 'Outcome'],
              data.audit.map(function (event) {
                return [
                  new Date(event.timestamp).toISOString(),
                  event.action,
                  event.operation || '-',
                  pill(event.outcome, event.outcome === 'success' ? 'ok' : 'bad'),
                ];
              }),
            ),
          );
        }

        var test = el('button', 'secondary', 'Test connection');
        test.addEventListener('click', function () {
          post('/inspector/api/connections/' + data.connection.id + '/test')
            .then(function (result) {
              section.appendChild(
                el(
                  'p',
                  null,
                  'Probe: ' +
                    (result.probe.ok ? 'ok' : 'failed') +
                    ' (status ' +
                    result.probe.status +
                    ', ' +
                    result.probe.durationMs +
                    'ms)',
                ),
              );
            })
            .catch(function (error) {
              section.appendChild(el('p', null, 'Probe failed: ' + error.message));
            });
        });
        section.appendChild(test);
      }

      function renderAudit(data) {
        var section = document.getElementById('audit');
        section.replaceChildren();
        section.appendChild(el('h2', null, 'Audit activity (tenant-scoped)'));
        if (data.events.length === 0) {
          section.appendChild(el('p', 'muted', 'No audit events for this tenant.'));
          return;
        }
        section.appendChild(
          table(
            ['Time', 'Action', 'Connection', 'Operation', 'Outcome'],
            data.events.map(function (event) {
              return [
                new Date(event.timestamp).toISOString(),
                event.action,
                event.connectionId || '-',
                event.operation || '-',
                pill(event.outcome, event.outcome === 'success' ? 'ok' : 'bad'),
              ];
            }),
          ),
        );
      }

      function loadDetail(connectionId) {
        document.getElementById('detail').replaceChildren();
        document.getElementById('detail').appendChild(
          el('p', 'muted', 'Loading ' + connectionId + '...'),
        );
        api('/inspector/api/connections/' + encodeURIComponent(connectionId))
          .then(renderDetail)
          .catch(function (error) {
            document
              .getElementById('detail')
              .replaceChildren(el('p', null, 'Failed: ' + error.message));
          });
      }

      function loadAll() {
        var errorBox = document.getElementById('error');
        errorBox.textContent = '';
        Promise.all([
          api('/inspector/api/overview'),
          api('/inspector/api/connections'),
          api('/inspector/api/audit'),
        ])
          .then(function (results) {
            renderOverview(results[0]);
            renderConnections(results[1]);
            renderAudit(results[2]);
          })
          .catch(function (error) {
            errorBox.textContent = error.message;
          });
      }

      document.getElementById('load').addEventListener('click', function () {
        token = document.getElementById('token').value.trim();
        loadAll();
      });
      document.getElementById('token').addEventListener('keydown', function (event) {
        if (event.key === 'Enter') {
          token = document.getElementById('token').value.trim();
          loadAll();
        }
      });
      api('/inspector/api/meta').then(function (meta) {
        document.getElementById('meta').textContent =
          meta.product + ' ' + meta.version + ' - auth ' + meta.authMode +
          (meta.registryRevision !== undefined
            ? ' - registry revision ' + meta.registryRevision
            : '');
      });
    </script>
  </body>
</html>
`;
