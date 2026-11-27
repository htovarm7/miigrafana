# Mobile log format

One JSON line per event, sent to Loki with labels `app="miicel-mobile"` and `level=info|warning|error`. Everything else is a JSON field (`| json`). Field names are exact.

## Fields

| Field | Meaning |
|---|---|
| `Service` | `miicel-mobile` |
| `Event` | Event name from the table below |
| `Reason` | Short text (max 300 chars) |
| `Flow` | Business process: `auth`, `accounts`, `loans`, `saving-targets`, `saving-fund`, `investments`, `miicel`, `miivida`, `e-signature`, `profile`, `statements`, `address-book`, `other` |
| `Stage` | Screen or step (`Login`, `ErrorBoundary`, ...) |
| `Endpoint` | API route, no host, query or ids (`api/usr/loan/{id}/payment`) |
| `Status` | HTTP status |
| `DurationMs` | API call duration |
| `UserId` | Member number. Only unique inside a company: always read it with `Company` |
| `Company` | Company number |
| `CorrelationId` | One app session (a new one per launch) |
| `Screen` | Screen open when the line was sent |
| `env`, `platform`, `AppVersion`, `OsVersion` | Where it ran |
| `Method`, `IsMutation` | HTTP method, true for non-GET |
| `Breadcrumbs` | Last 15 actions before an error or crash |
| `ErrorName`, `Stack`, `IsFatal`, `ComponentStack` | Crash details |
| `Recovered` | `true` when a crash was saved and sent on the next launch |

Never logged: passwords, tokens, request/response bodies, CURP, query strings, ids in paths.

## Events

| Event | Level | When |
|---|---|---|
| `app.start` | info | App launched |
| `app.state` | info | Went to background / foreground |
| `nav.screen` | info | Screen changed |
| `auth.login` | info / warning | Login result (`Result`: success, invalid_credentials, ...) |
| `auth.session_started` | info | Session opened |
| `auth.logout` | info | Logout |
| `api.request` | info | API call 2xx/3xx |
| `api.client_error` | warning | API 4xx |
| `api.server_error` | error | API 5xx |
| `api.network_error` | error | No connection / timeout |
| `app.crash` | error | Uncaught fatal JS exception |
| `app.error` | error | Uncaught non-fatal JS exception |
| `app.render_error` | error | A screen failed to render (error boundary) |
| `app.unhandled_rejection` | error | Promise rejected with no catch |
| `ui.unexpected_error` | error | Unexpected error shown to the user |

Native crashes (Java/Objective-C/out of memory) are not captured; only JS errors are.

## Queries

```
{app="miicel-mobile"} | json | Event=~"app.crash|app.render_error"
{app="miicel-mobile"} | json | Flow="loans" | level="error"
{app="miicel-mobile"} | json | Event="api.request" | unwrap DurationMs
{app="miicel-mobile"} | json | UserId="2112" | Company="25"
```

## How it reads in Grafana

Lines are stored as JSON. The dashboard log panels show them with `line_format`:

```
error | api.server_error | socio 2112 emp 25 | android 4.9 | pantalla: SavingTarget
  motivo: GET api/usr/savingtargeted/{id}/details/{id} -> 500
  api: api/usr/savingtargeted/{id}/details/{id} 500 4200ms
  pasos previos: 12:01:03 screen SavingTarget | 12:01:04 api GET ... 500
```

Errors and Crashes show stack and breadcrumbs; Audit and Trace show one compact line. In Explore, add the same `| line_format` or open a line to see every field.
