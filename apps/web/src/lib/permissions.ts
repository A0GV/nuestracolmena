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
];

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
  'manageFunction/invoke',
  'manageConfig',
  'accessTheHiveFS',
];

export const ORG_USER_PERMISSIONS = ['manageUser/org'];

export const ALL_PERMISSIONS = [...PLATFORM_PERMISSIONS, ...ORG_PERMISSIONS, ...ORG_USER_PERMISSIONS];

const ANALYST_EXCLUDED = new Set([
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
