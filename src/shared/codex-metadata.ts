export type CodexMetadataMethod =
  | 'initialize'
  | 'account/read'
  | 'model/list'
  | 'account/rateLimits/read';

export interface CodexMetadataBucket {
  limitId: string | null;
  spendControlReached: boolean | null;
  hasCredits: boolean | null;
  unlimitedCredits: boolean | null;
}

export interface CodexMetadataObservation {
  schema: 'dream-maker.codex-metadata-observation.v1';
  observedAt: string;
  currentConfiguration: boolean;
  configurationFingerprint: string | null;
  route: {
    state: 'CFW_LEASE_BOUND_CHILD_ENVIRONMENT' | 'DM_ROUTE_DISABLED' | 'UNMANAGED_ENV_PRESENT';
    proxyEndpoint: string | null;
    environmentFingerprint: string | null;
  };
  controller: {
    selectionPolicy: 'pinned' | 'current';
    selectedNode: string | null;
    expectedNode: string | null;
  } | null;
  account: {
    state: 'OBSERVED' | 'UNKNOWN';
    type: 'chatgpt' | 'apiKey' | 'unknown';
    authentication: 'AUTHENTICATED_METADATA_ONLY' | 'NOT_VERIFIED';
  };
  model: {
    configured: string;
    listed: boolean | null;
    catalogComplete: boolean;
    actualServedModel: 'NOT_VERIFIED';
  };
  usage: {
    ordinaryUsageAllowed: boolean | null;
    state: 'ALLOWED' | 'RESTRICTED' | 'UNKNOWN';
    buckets: CodexMetadataBucket[];
  };
  serviceEligibility: {
    state: 'NOT_VERIFIED' | 'USAGE_RESTRICTED';
    summary: string;
  };
  inference: {
    state: 'NOT_RUN';
    summary: string;
  };
  dispatchGate: {
    state: 'BLOCKED_BY_USAGE' | 'BLOCKED_BY_MODEL' | 'NOT_BLOCKED_BY_METADATA' | 'UNKNOWN';
    summary: string;
  };
  errors: {
    method: CodexMetadataMethod;
    code: string;
    category: string;
  }[];
  modelTurnsRequested: 0;
  cleanupReturned: boolean;
}

const timestamp = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^20\d\d-\d\d-\d\dT[0-9:.]+(?:Z|[+-]\d\d:\d\d)$/.test(value) &&
  Number.isFinite(Date.parse(value));

const safeText = (value: unknown, max: number): value is string =>
  typeof value === 'string' &&
  value.length <= max &&
  !/[\x00-\x1f\x7f]/.test(value);

const safeCode = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Z0-9_|]{1,120}$/.test(value);

const methods = new Set<CodexMetadataMethod>([
  'initialize',
  'account/read',
  'model/list',
  'account/rateLimits/read'
]);

export function readCodexMetadataObservation(raw: unknown): CodexMetadataObservation {
  const value = raw as CodexMetadataObservation;
  if (
    !value ||
    value.schema !== 'dream-maker.codex-metadata-observation.v1' ||
    !timestamp(value.observedAt) ||
    typeof value.currentConfiguration !== 'boolean' ||
    value.configurationFingerprint !== null &&
      (typeof value.configurationFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(value.configurationFingerprint)) ||
    !value.route ||
    !['CFW_LEASE_BOUND_CHILD_ENVIRONMENT', 'DM_ROUTE_DISABLED', 'UNMANAGED_ENV_PRESENT'].includes(value.route.state) ||
    value.route.proxyEndpoint !== null &&
      (typeof value.route.proxyEndpoint !== 'string' ||
        !/^(?:127[.]0[.]0[.]1|10(?:[.]\d{1,3}){3}|172[.](?:1[6-9]|2\d|3[01])(?:[.]\d{1,3}){2}|192[.]168(?:[.]\d{1,3}){2}):[1-9][0-9]{0,4}$/.test(value.route.proxyEndpoint)) ||
    value.route.environmentFingerprint !== null &&
      (typeof value.route.environmentFingerprint !== 'string' ||
        !/^[a-f0-9]{64}$/.test(value.route.environmentFingerprint)) ||
    value.controller !== null &&
      (!['pinned', 'current'].includes(value.controller?.selectionPolicy) ||
        !(value.controller?.selectedNode === null || safeText(value.controller?.selectedNode, 512)) ||
        !(value.controller?.expectedNode === null || safeText(value.controller?.expectedNode, 512))) ||
    !value.account ||
    !['OBSERVED', 'UNKNOWN'].includes(value.account.state) ||
    !['chatgpt', 'apiKey', 'unknown'].includes(value.account.type) ||
    !['AUTHENTICATED_METADATA_ONLY', 'NOT_VERIFIED'].includes(value.account.authentication) ||
    !value.model ||
    !safeText(value.model.configured, 200) ||
    value.model.listed !== null && typeof value.model.listed !== 'boolean' ||
    typeof value.model.catalogComplete !== 'boolean' ||
    value.model.actualServedModel !== 'NOT_VERIFIED' ||
    !value.usage ||
    value.usage.ordinaryUsageAllowed !== null && typeof value.usage.ordinaryUsageAllowed !== 'boolean' ||
    !['ALLOWED', 'RESTRICTED', 'UNKNOWN'].includes(value.usage.state) ||
    !Array.isArray(value.usage.buckets) ||
    value.usage.buckets.length > 24 ||
    value.usage.buckets.some((bucket) =>
      !bucket ||
      bucket.limitId !== null && !safeText(bucket.limitId, 160) ||
      bucket.spendControlReached !== null && typeof bucket.spendControlReached !== 'boolean' ||
      bucket.hasCredits !== null && typeof bucket.hasCredits !== 'boolean' ||
      bucket.unlimitedCredits !== null && typeof bucket.unlimitedCredits !== 'boolean') ||
    !value.serviceEligibility ||
    !['NOT_VERIFIED', 'USAGE_RESTRICTED'].includes(value.serviceEligibility.state) ||
    !safeText(value.serviceEligibility.summary, 800) ||
    !value.inference ||
    value.inference.state !== 'NOT_RUN' ||
    !safeText(value.inference.summary, 800) ||
    !value.dispatchGate ||
    !['BLOCKED_BY_USAGE', 'BLOCKED_BY_MODEL', 'NOT_BLOCKED_BY_METADATA', 'UNKNOWN'].includes(value.dispatchGate.state) ||
    !safeText(value.dispatchGate.summary, 800) ||
    !Array.isArray(value.errors) ||
    value.errors.length > 8 ||
    value.errors.some((error) =>
      !error ||
      !methods.has(error.method) ||
      !safeCode(error.code) ||
      !safeCode(error.category)) ||
    value.modelTurnsRequested !== 0 ||
    typeof value.cleanupReturned !== 'boolean'
  ) {
    throw Error('CODEX_METADATA_OBSERVATION_INVALID');
  }

  if (
    value.account.state === 'OBSERVED' !== (value.account.authentication === 'AUTHENTICATED_METADATA_ONLY') ||
    value.account.state === 'OBSERVED' && value.account.type === 'unknown' ||
    value.account.state === 'UNKNOWN' && value.account.type !== 'unknown' ||
    value.usage.ordinaryUsageAllowed === false !== (value.usage.state === 'RESTRICTED') ||
    value.usage.ordinaryUsageAllowed === true !== (value.usage.state === 'ALLOWED') ||
    value.usage.state === 'RESTRICTED' && value.serviceEligibility.state !== 'USAGE_RESTRICTED' ||
    value.usage.state !== 'RESTRICTED' && value.serviceEligibility.state === 'USAGE_RESTRICTED' ||
    value.usage.state === 'RESTRICTED' && value.dispatchGate.state !== 'BLOCKED_BY_USAGE' ||
    value.usage.state !== 'RESTRICTED' && value.dispatchGate.state === 'BLOCKED_BY_USAGE'
  ) {
    throw Error('CODEX_METADATA_OBSERVATION_INVALID');
  }

  return structuredClone(value);
}
