export const PLATFORM_PERMISSIONS = [
  'manageOrganisation',
  'manageProfile',
  'manageUser',
  'manageCustomField',
  'manageObservableTemplate',
  'managePattern',
  'manageTaxonomy',
  'managePlatform',
  'manageConfig',
  'manageAnalyzerTemplate',
  'manageKnowledgeBase',
] as const;

export const ORG_PERMISSIONS = [
  'manageCase/create',
  'manageCase/update',
  'manageCase/delete',
  'manageCase/merge',
  'manageCase/reopen',
  'manageCase/changeOwnership',
  'manageCaseAccess/restrict',
  'manageCaseAccess/external',
  'manageTask',
  'manageObservable',
  'manageProcedure',
  'manageAlert/create',
  'manageAlert/update',
  'manageAlert/delete',
  'manageAlert/import',
  'manageAlert/reopen',
  'manageShare',
  'manageAnalyse',
  'manageAction',
  'manageComment',
  'manageCustomEvent',
  'manageDashboard',
  'manageKnowledgeBase',
  'managePage',
  'managePageTemplate',
  'manageCaseTemplate',
  'manageCaseReport',
  'manageCaseReportTemplate',
  'manageSla',
  'manageTag',
  'manageFunction/create',
  // API-key users need manageFunction/invoke (or manageConfig) to POST /api/v1/function/:name.
  'manageFunction/invoke',
  'manageConfig',
  'accessTheHiveFS',
] as const;

/** Organisation-scoped user administration (org-admin). */
export const ORG_USER_PERMISSIONS = ['manageUser/org'] as const;

export const ALL_PERMISSIONS = [...PLATFORM_PERMISSIONS, ...ORG_PERMISSIONS, ...ORG_USER_PERMISSIONS];

/**
 * Analysts do the daily SOC work but cannot change the organisation
 * configuration, templates, SLA rules or create functions.
 */
const ANALYST_EXCLUDED = new Set<string>([
  'manageConfig',
  'manageCaseTemplate',
  'manageCaseReportTemplate',
  'managePageTemplate',
  'manageSla',
  'manageFunction/create',
  'manageCaseAccess/external',
]);

export const ANALYST_PERMISSIONS = ORG_PERMISSIONS.filter((permission) => !ANALYST_EXCLUDED.has(permission));

export const ORG_ADMIN_PERMISSIONS = [...ORG_PERMISSIONS, ...ORG_USER_PERMISSIONS];

export const PROFILE_DEFINITIONS = {
  admin: { type: 'admin', permissions: ALL_PERMISSIONS as string[] },
  analyst: { type: 'organisation', permissions: ANALYST_PERMISSIONS as string[] },
  'org-admin': { type: 'organisation', permissions: ORG_ADMIN_PERMISSIONS as string[] },
  'read-only': { type: 'organisation', permissions: [] as string[] },
  'external-actor': {
    type: 'external',
    permissions: ['manageCase/create', 'manageCase/update', 'manageComment', 'manageObservable'],
  },
  'external-reader': { type: 'external', permissions: [] as string[] },
};

export const CASE_NEW = 'New';
export const CASE_IN_PROGRESS = 'InProgress';
export const CASE_CLOSED = 'Closed';

export const TASK_STATUSES = ['Waiting', 'InProgress', 'Completed', 'Cancel'];

export const SEVERITIES: Record<number, string> = {
  1: 'LOW',
  2: 'MEDIUM',
  3: 'HIGH',
  4: 'CRITICAL',
};

export const TLP_PAP: Record<number, string> = {
  0: 'WHITE',
  1: 'GREEN',
  2: 'AMBER',
  3: 'RED',
};
