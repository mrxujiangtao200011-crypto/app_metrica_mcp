# Changelog

## 0.3.0 — 2026-10-03

Major update: the MCP can now build analytics in AppMetrica itself, not only read it.

### Added
- **Funnels** — `list_funnels`, `get_funnel_report` (saved or ad-hoc steps, same numbers as the web report via `ym:uf:devicesInStepN` + `funnel_pattern`), `create_funnel` / `update_funnel` / `delete_funnel` (write mode).
- **Segments** — `list_segments`, `get_segment`, `segment_id` on every report tool, `create_segment` / `update_segment` / `delete_segment` (write mode).
- **Dashboards** — `get_dashboard` with 17 Reporting-API presets, `list_dashboard_presets`, local workspaces (`save_workspace`, `list_workspaces`, `get_workspace`, `delete_workspace`).
- **Web session (experimental)** — workspaces and widgets inside AppMetrica through the web client's internal GraphQL, driven by a real Chrome session (`npx appmetrica-mcp login` once, headless afterwards): `web_session_status`, `web_list_workspaces`, `web_get_workspace`, `web_list_widget_presets`, `web_list_report_namespaces`, `web_create_workspace`, `web_add_widgets`, `web_add_header`, `web_rename_workspace`, `web_remove_widget`, `web_delete_workspace`, `web_push_workspace`.
- **Reporting API** — `get_report_bytime`; `filters`, `sort`, `currency`, `accuracy`, `include_undefined`, `lang`, `offset` on `get_report`; `list_metrics` rebuilt from the official docs (197 metrics, 188 dimensions, incl. revenue / e-commerce / conversions) with `search` / `namespace` filters; `scripts/update-catalog.mjs` regenerates it.
- **Management API** — `list_events`, `list_conversions`, `get_logs_api_status`, `audit_events` (instrumentation audit).
- **Logs API** — `export_logs` for all 13 tables with documented fields.
- **Prompt** `analytics_setup` — end-to-end workflow: audit events → design and save funnels/segments → build dashboards → report instrumentation gaps.
- Auto-retry of the sporadic Reporting API 400 "Запрос слишком сложный".
- `server.json` for the official MCP Registry.

### Changed
- Version 0.3.0; `playwright-core` dependency (uses the system Google Chrome, no browser download).

## 0.1.4 and earlier
- Reporting / Logs / Management / Push basics. See git history.
