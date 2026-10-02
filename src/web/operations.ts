// GraphQL documents of the AppMetrica web client, reconstructed from recorded traffic
// (2026-10-03, web client 1.141.1). The web client generates every document as
//   <fragments> <kind> <name>(<$args>) { <name>(<args>) { data <selection>, error { ...apiError } } }
// so we keep fragments once and compose documents the same way. Re-record with
// scripts/record-graphql.mjs if the web client changes its entities.

const FRAGMENTS: Record<string, string> = {
  apiErrorReason: "fragment apiErrorReason on ApiErrorReason { kind message location }",
  apiError: "fragment apiError on ApiError { kind reason { ...apiErrorReason } }",
  dateDto: "fragment dateDto on DateDto { day month year apiFormat }",
  userAccount: "fragment userAccount on UserAccount { uid login displayName avatarId firstName lastName birthday phone email isPorg }",
  dashboard2WidgetGroupHeader: "fragment dashboard2WidgetGroupHeader on Dashboard2WidgetGroupHeader { title subtitle isDisabled }",
  appmetrDashboard2WidgetEntity:
    "fragment appmetrDashboard2WidgetEntity on AppmetrDashboard2WidgetEntity { dashboardWidgetId widgetId viewKind selectedMetricId selectedDimensionId funnelId }",
  appmetrDashboard2GroupEntity:
    "fragment appmetrDashboard2GroupEntity on AppmetrDashboard2GroupEntity { dashboardWidgetGroupId widgets { ...appmetrDashboard2WidgetEntity } header { ...dashboard2WidgetGroupHeader } }",
  appmetrDashboard2Entity:
    "fragment appmetrDashboard2Entity on AppmetrDashboard2Entity { dashboardId isSystem presetKind widgetsGroups { ...appmetrDashboard2GroupEntity } name sourceId sourceKind created { ...dateDto } owner { ...userAccount } isEditable isRemovable isWidgetsListEditable canBeSelectedAsFavorite canBeReset hasAccess customUrl isNew }",
  report2Attribute: "fragment report2Attribute on Report2Attribute { id customParam }",
  customAttributeParam: "fragment customAttributeParam on CustomAttributeParam { kind template metrics dimensions }",
  appmetrReport2MetricMeta:
    "fragment appmetrReport2MetricMeta on AppmetrReport2MetricMeta { id title description isNDA isSecret exposesSecretData customParamKind templaterKind parameters { ...customAttributeParam } isSortable isHidden valueType isNormalizable disallowByTime isFilterable isNegative legacyId metricId absValueType }",
  appmetrReport2DimensionMeta:
    "fragment appmetrReport2DimensionMeta on AppmetrReport2DimensionMeta { id title description isNDA isSecret exposesSecretData customParamKind templaterKind parameters { ...customAttributeParam } isSortable isHidden type valueIntervalKind isSearchable disallowByTime searchDim legacyId searchId }",
  appmentrReport2MetaEntity:
    "fragment appmentrReport2MetaEntity on AppmentrReport2MetaEntity { metrics { ...appmetrReport2MetricMeta } dimensions { ...appmetrReport2DimensionMeta } }",
  report2SortBy: "fragment report2SortBy on Report2SortBy { order attributeId attributeParam }",
  segmentFilterDesc: "fragment segmentFilterDesc on SegmentFilterDesc { id data }",
  reportSegmentation: "fragment reportSegmentation on ReportSegmentation { kind segmentId value { ...segmentFilterDesc } }",
  period: "fragment period on Period { timezoneOffset from { ...dateDto } to { ...dateDto } preset countDays relativePeriodType }",
  reportComparisonSegment: "fragment reportComparisonSegment on ReportComparisonSegment { segment { ...reportSegmentation } period { ...period } }",
  appmetrWidget2Entity:
    "fragment appmetrWidget2Entity on AppmetrWidget2Entity { metrics { ...report2Attribute } showTotal currency selectedDimensionIds chartMetric { ...report2Attribute } chartMetrics { ...report2Attribute } widgetId categoryIds requiredAuthActions namespace name dimensions { ...report2Attribute } meta { ...appmentrReport2MetaEntity } sortBy { ...report2SortBy } reportId comparisonSegments { ...reportComparisonSegment } defaultViewKind funnelId minCohortSize eventsSourceKind attributionModel inactivityWindow uaDataSource segment description brackets groupMethod tableGroupByInterval retention }",
  appmetrCreateDashboardWidgetGroupResponseEntity:
    "fragment appmetrCreateDashboardWidgetGroupResponseEntity on AppmetrCreateDashboardWidgetGroupResponseEntity { dashboardId group { ...appmetrDashboard2GroupEntity } widgets { ...appmetrWidget2Entity } }",
  dashboardsLimits: "fragment dashboardsLimits on DashboardsLimits { dashboardsLimit widgetsLimit groupsLimit }",
  dashboardsParams: "fragment dashboardsParams on DashboardsParams { favoriteDashboardId dashboardsLimit limits { ...dashboardsLimits } }",
  report2AttributeTree: "fragment report2AttributeTree on Report2AttributeTree { nodeId title attributes requireParam parentId childNodes }",
  appmetrDefaultWidgetPresetEntity:
    "fragment appmetrDefaultWidgetPresetEntity on AppmetrDefaultWidgetPresetEntity { metrics { ...report2Attribute } dimensions { ...report2Attribute } }",
  appmetrReport2NamespaceEntity:
    "fragment appmetrReport2NamespaceEntity on AppmetrReport2NamespaceEntity { id metricsTree { ...report2AttributeTree } dimensionsTree { ...report2AttributeTree } isComparisonDisabled metrics { ...appmetrReport2MetricMeta } dimensions { ...appmetrReport2DimensionMeta } apiTableId defaultWidgetPreset { ...appmetrDefaultWidgetPresetEntity } name isLinearViewDisabled isSegmentationDisabled enableAgencyExport }",
  savedSegment: "fragment savedSegment on SavedSegment { segmentId title settings { ...segmentFilterDesc } expression sourceId owner isEditable createTime }",
  widgetMetricTotal: "fragment widgetMetricTotal on WidgetMetricTotal { value dimensions }",
  widgetMetric: "fragment widgetMetric on WidgetMetric { metricId values cohortSize dimensions total { ...widgetMetricTotal } prevPeriodTotal { ...widgetMetricTotal } }",
  dimensionDesc: "fragment dimensionDesc on DimensionDesc { name key id favicon url comment iconType iconId rootIconId directId isExternalDirectOwner campaignId }",
  widgetAnnotation: "fragment widgetAnnotation on WidgetAnnotation { id title message group date time }",
  widgetData:
    "fragment widgetData on WidgetData { widgetId metrics { ...widgetMetric } comparisonMetrics { ...widgetMetric } dimensions { ...dimensionDesc } totalDimensionsCount timeIntervals comparisonTimeIntervals lastDataIndex comparisonLastDataIndex annotations { ...widgetAnnotation } period { ...period } groupByInterval autoGroupSize hasSensitiveData }",
};

export type WebOperation = {
  kind: "query" | "mutation";
  // GraphQL variable declarations, in the order the web client sends them.
  args: Record<string, string>;
  // Selection for `data` — a fragment spread (`{ ...x }`) or "" for scalar results.
  selection: string;
};

export const OPERATIONS = {
  dashboards: { kind: "query", args: { sourceId: "String", sourceDescriptor: "SourceDescriptorInput" }, selection: "{ ...appmetrDashboard2Entity }" },
  dashboard: { kind: "query", args: { dashboardId: "String!", sourceDescriptor: "SourceDescriptorInput" }, selection: "{ ...appmetrDashboard2Entity }" },
  dashboardsParams: { kind: "query", args: { sourceId: "String", sourceDescriptor: "SourceDescriptorInput" }, selection: "{ ...dashboardsParams }" },
  widgets: { kind: "query", args: { sourceId: "String", sourceDescriptor: "SourceDescriptorInput" }, selection: "{ ...appmetrWidget2Entity }" },
  availableNamespaces2: { kind: "query", args: { sourceDescriptor: "SourceDescriptorInput!" }, selection: "{ ...appmetrReport2NamespaceEntity }" },
  namespaceMetadata2: { kind: "query", args: { sourceDescriptor: "SourceDescriptorInput!", namespaceId: "String!" }, selection: "{ ...appmetrReport2NamespaceEntity }" },
  savedSegments: { kind: "query", args: { id: "String!" }, selection: "{ ...savedSegment }" },
  widgetData: { kind: "query", args: { baseParams: "AppmetrReportsBaseParamsInput!", request: "WidgetDataRequestInput!" }, selection: "{ ...widgetData }" },
  createDashboard3: {
    kind: "mutation",
    args: { sourceId: "String", name: "String!", widgetsGroups: "[AppmetrDashboard2WidgetGroupInput!]", sourceDescriptor: "SourceDescriptorInput" },
    selection: "{ ...appmetrDashboard2Entity }",
  },
  createDashboardWidgetGroup: {
    kind: "mutation",
    args: { dashboardId: "String!", widgets: "[AppmetrDashboard2WidgetInput!]!", position: "Int", sourceDescriptor: "SourceDescriptorInput" },
    selection: "{ ...appmetrCreateDashboardWidgetGroupResponseEntity }",
  },
  createDashboardWidgetHeader: {
    kind: "mutation",
    args: { dashboardId: "String!", header: "Dashboard2WidgetGroupHeaderInput!", position: "Int", sourceDescriptor: "SourceDescriptorInput" },
    selection: "{ ...appmetrDashboard2GroupEntity }",
  },
  updateDashboardName3: { kind: "mutation", args: { dashboardId: "String!", name: "String!", sourceDescriptor: "SourceDescriptorInput" }, selection: "" },
  removeDashboardWidget: { kind: "mutation", args: { dashboardId: "String!", dashboardWidgetId: "String!", sourceDescriptor: "SourceDescriptorInput" }, selection: "" },
  removeDashboard3: { kind: "mutation", args: { dashboardId: "String!", sourceDescriptor: "SourceDescriptorInput" }, selection: "" },
} satisfies Record<string, WebOperation>;

export type WebOperationName = keyof typeof OPERATIONS;

function collectFragments(selection: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const visit = (text: string) => {
    for (const m of text.matchAll(/\.\.\.([A-Za-z0-9_]+)/g)) {
      const name = m[1];
      if (seen.has(name)) continue;
      const frag = FRAGMENTS[name];
      if (!frag) throw new Error(`Unknown GraphQL fragment: ${name}`);
      seen.add(name);
      out.push(frag);
      visit(frag);
    }
  };
  visit(selection);
  return out;
}

// Builds the document exactly in the shape the web client sends it.
export function buildDocument(name: WebOperationName): string {
  const op: WebOperation = OPERATIONS[name];
  const fragments = collectFragments(`${op.selection} { ...apiError }`);
  const decl = Object.entries(op.args).map(([k, t]) => `$${k} : ${t}`).join(", ");
  const pass = Object.keys(op.args).map((k) => `${k} : $${k}`).join(", ");
  const data = op.selection ? `data ${op.selection}` : "data ";
  return `${fragments.join(" ")} ${op.kind} ${name}(${decl}) { ${name}(${pass}) { ${data}, error { ...apiError } } }`;
}
