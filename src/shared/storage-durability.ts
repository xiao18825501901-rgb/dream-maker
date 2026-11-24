export interface StorageVolumeHealth {
  schema: 'dream-maker.storage-volume-health.v1';
  scope: 'VOLUME_HEALTH_ONLY';
  drive: string;
  fileSystem: string | null;
  healthStatus: string | null;
  operationalStatus: string | null;
  totalBytes: number | null;
  availableBytes: number | null;
  state: 'HEALTHY' | 'REPAIR_REQUIRED' | 'UNKNOWN';
  evidence: 'WINDOWS_STORAGE_READ_ONLY' | 'PROBE_UNAVAILABLE';
  checkedAt: string;
}
