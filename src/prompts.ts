export type AnalyticsSetupArgs = { app_id: string; project_path?: string; goal?: string };

const iso = (d: Date): string => d.toISOString().slice(0, 10);

// Workflow prompt: analyse the project and its analytics, build funnels/segments/dashboards, report instrumentation gaps.
export function analyticsSetupPrompt({ app_id, project_path, goal }: AnalyticsSetupArgs): string {
  // Last 28 full days: yesterday and the 27 days before it.
  const end = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const start = new Date(end.getTime() - 27 * 24 * 60 * 60 * 1000);
  const period = `date_from=${iso(start)}, date_to=${iso(end)}`;

  const codeStep = project_path
    ? `Search the codebase at ${project_path} for AppMetrica event calls: \`reportEvent\`, \`YandexMetrica.reportEvent\`, \`AppMetrica.reportEvent\`, \`AMAAppMetrica\`, \`reportEvent(name:\`. Collect every event name together with its parameters (keys and typical values). Then call audit_events again with expected_events set to the collected names, to see which events exist in code but send no data and which active events are not in code.`
    : `No project_path was given, so skip the code scan: rely on list_events / audit_events only and say so in the final report.`;

  return `Set up product analytics for AppMetrica application ${app_id} (use ${app_id} as app_id in every tool call).${goal ? `\nGoal: ${goal}` : ""}

Reporting period for everything below: last 28 days (${period}).

## 1. Discover the app and its events
- get_application(app_id) — name and platform.
- list_events(app_id) — registered client events.
- audit_events(app_id, ${period}) — volumes per event, zero-volume events and findings.

## 2. Compare with the code
${codeStep}

## 3. Funnels
Design 3-6 funnels for the core flows: onboarding -> activation, registration, purchase/subscription, key feature engagement. Use only events that actually exist and have data. For each funnel:
1. Verify it first with get_funnel_report(steps=[...], ${period}) — step counts should be non-zero and decreasing; adjust the steps if not.
2. Then persist it with create_funnel. This requires APPMETRICA_ALLOW_WRITE=true on the server; if the tool reports that write operations are disabled, output the funnel definitions (name, steps, options) instead and carry on.
Saved funnels support only client-event steps (at most one event param per step) and install steps; use get_funnel_report for anything else.

## 4. Segments
Where useful, create 1-3 segments with create_segment (e.g. users who completed onboarding, users who reached the paywall, paying users). Same write requirement as above. Check each with get_report(segment_id=...).

## 5. Dashboard
- Run get_dashboard with the presets that fit the app (default set: audience, installs, engagement, crashes, events; add revenue, ad_revenue, funnels, traffic when relevant) for the period, and keep the useful set with save_workspace(name, widgets, app_id).
- Create the workspace in AppMetrica itself when possible: check web_session_status; if logged in and write mode is on, run web_push_workspace(app_id, workspace=<saved name>) (or web_create_workspace with explicit groups: headers, web presets from web_list_widget_presets, custom widgets, funnel widgets via funnel_id) and report the returned url. If the session is not logged in, say that running 'npx appmetrica-mcp login' enables this.
- Otherwise finish with a "Web dashboard blueprint": a table with one row per widget — widget -> AppMetrica web report, metrics, dimension, segment — so it can be built by hand in the web UI.

## 6. Instrumentation gaps
End with an "Instrumentation gaps" section, each item with a concrete recommendation:
- missing and zero-volume events (from audit_events);
- parameters missing from events that the funnels need;
- revenue / e-commerce not instrumented (check the totals of the revenue preset);
- naming inconsistencies (snake_case vs CamelCase, duplicates, renamed events).
`;
}
