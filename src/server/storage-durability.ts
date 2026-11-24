import {spawn} from 'node:child_process';
import {isAbsolute,parse,resolve} from 'node:path';
import {DomainError,childEnv,object} from './security.js';
import type {StorageVolumeHealth} from '../shared/storage-durability.js';

type RawVolumeHealth = {
  schema: 'dream-maker.windows-volume-health.v1';
  drive: string;
  fileSystem: string;
  healthStatus: string;
  operationalStatus: string;
  totalBytes: number;
  availableBytes: number;
};

type ProbeOptions = {
  runner?: (drive: string) => Promise<unknown>;
  now?: () => Date;
};

const MAX_PROBE_OUTPUT = 32768;
const PROBE_TIMEOUT_MS = 10000;
const probeScript = String.raw`
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$root=$env:DM_VOLUME_HEALTH_ROOT
if($root -notmatch '^[A-Za-z]:[\\/]$'){throw 'INVALID_VOLUME_ROOT'}
$letter=[char]::ToUpperInvariant($root[0])
$v=Get-Volume -DriveLetter $letter
if($null -eq $v -or [string]::IsNullOrWhiteSpace([string]$v.FileSystem)){throw 'VOLUME_NOT_FOUND'}
[ordered]@{
 schema='dream-maker.windows-volume-health.v1'
 drive=([string]$v.DriveLetter+':')
 fileSystem=[string]$v.FileSystem
 healthStatus=[string]$v.HealthStatus
 operationalStatus=[string]$v.OperationalStatus
 totalBytes=[uint64]$v.Size
 availableBytes=[uint64]$v.SizeRemaining
}|ConvertTo-Json -Compress
`;

function driveFor(directory: string): string {
  if (!isAbsolute(directory)) throw new DomainError('STORAGE_VOLUME_PATH_DENIED', 409);
  const parsed = parse(resolve(directory));
  if (!/^[A-Za-z]:$/.test(parsed.root.slice(0, 2))) throw new DomainError('STORAGE_VOLUME_PATH_DENIED', 409);
  return parsed.root.slice(0, 1).toUpperCase() + ':';
}

async function windowsProbe(drive: string): Promise<unknown> {
  if (process.platform !== 'win32') throw new Error('WINDOWS_STORAGE_PROBE_REQUIRED');
  const executable = resolve(process.env.SystemRoot || 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const encoded = Buffer.from(probeScript, 'utf16le').toString('base64');
  return await new Promise((resolveValue, reject) => {
    const child = spawn(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
      cwd: process.cwd(),
      env: childEnv({DM_VOLUME_HEALTH_ROOT: drive + '\\'}),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });
    let stdout = '', stderr = '', bytes = 0, settled = false;
    const finish = (error: Error | null, value?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else resolveValue(value);
    };
    const consume = (chunk: Buffer, target: 'stdout' | 'stderr') => {
      bytes += chunk.length;
      if (bytes > MAX_PROBE_OUTPUT) {
        child.kill();
        finish(new Error('STORAGE_VOLUME_PROBE_OUTPUT_LIMIT'));
        return;
      }
      if (target === 'stdout') stdout += chunk.toString('utf8'); else stderr += chunk.toString('utf8');
    };
    child.stdout.on('data', (chunk: Buffer) => consume(chunk, 'stdout'));
    child.stderr.on('data', (chunk: Buffer) => consume(chunk, 'stderr'));
    child.on('error', error => finish(error));
    child.on('close', code => {
      if (code !== 0 || stderr.trim()) {
        finish(new Error('STORAGE_VOLUME_PROBE_FAILED'));
        return;
      }
      try {
        finish(null, JSON.parse(stdout));
      } catch {
        finish(new Error('STORAGE_VOLUME_PROBE_INVALID'));
      }
    });
    const timer = setTimeout(() => {
      child.kill();
      finish(new Error('STORAGE_VOLUME_PROBE_TIMEOUT'));
    }, PROBE_TIMEOUT_MS);
  });
}

function known(rawValue: unknown, expectedDrive: string): RawVolumeHealth {
  const raw = object(rawValue), keys = Object.keys(raw).sort();
  const expected = [
    'availableBytes',
    'drive',
    'fileSystem',
    'healthStatus',
    'operationalStatus',
    'schema',
    'totalBytes'
  ];
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) throw new Error('PROBE_FIELDS_INVALID');
  if (raw.schema !== 'dream-maker.windows-volume-health.v1' || raw.drive !== expectedDrive) throw new Error('PROBE_IDENTITY_INVALID');
  const text = (value: unknown, max: number) => {
    if (typeof value !== 'string' || !value || value.length > max || /[\r\n\0]/.test(value)) throw new Error('PROBE_TEXT_INVALID');
    return value;
  };
  const totalBytes = Number(raw.totalBytes), availableBytes = Number(raw.availableBytes);
  if (!Number.isSafeInteger(totalBytes) || totalBytes <= 0 ||
      !Number.isSafeInteger(availableBytes) || availableBytes < 0 || availableBytes > totalBytes) {
    throw new Error('PROBE_CAPACITY_INVALID');
  }
  return {
    schema: 'dream-maker.windows-volume-health.v1',
    drive: expectedDrive,
    fileSystem: text(raw.fileSystem, 32),
    healthStatus: text(raw.healthStatus, 128),
    operationalStatus: text(raw.operationalStatus, 128),
    totalBytes,
    availableBytes
  };
}

export async function probeStorageVolumeHealth(directory: string, options: ProbeOptions = {}): Promise<StorageVolumeHealth> {
  const drive = driveFor(directory), now = options.now?.() ?? new Date();
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new DomainError('STORAGE_VOLUME_CLOCK_INVALID', 409);
  try {
    const raw = known(await (options.runner ?? windowsProbe)(drive), drive);
    const healthy = raw.healthStatus === 'Healthy' && raw.operationalStatus === 'OK';
    return {
      schema: 'dream-maker.storage-volume-health.v1',
      scope: 'VOLUME_HEALTH_ONLY',
      drive,
      fileSystem: raw.fileSystem,
      healthStatus: raw.healthStatus,
      operationalStatus: raw.operationalStatus,
      totalBytes: raw.totalBytes,
      availableBytes: raw.availableBytes,
      state: healthy ? 'HEALTHY' : 'REPAIR_REQUIRED',
      evidence: 'WINDOWS_STORAGE_READ_ONLY',
      checkedAt: now.toISOString()
    };
  } catch {
    return {
      schema: 'dream-maker.storage-volume-health.v1',
      scope: 'VOLUME_HEALTH_ONLY',
      drive,
      fileSystem: null,
      healthStatus: null,
      operationalStatus: null,
      totalBytes: null,
      availableBytes: null,
      state: 'UNKNOWN',
      evidence: 'PROBE_UNAVAILABLE',
      checkedAt: now.toISOString()
    };
  }
}

export function assertStorageVolumeHealthy(health: StorageVolumeHealth): void {
  const unknown = (): never => {
    throw new DomainError('STORAGE_VOLUME_HEALTH_UNKNOWN', 409);
  };
  if (!health || typeof health !== 'object') return unknown();
  const value = health as unknown as Record<string, unknown>;
  const keys = [
    'availableBytes',
    'checkedAt',
    'drive',
    'evidence',
    'fileSystem',
    'healthStatus',
    'operationalStatus',
    'schema',
    'scope',
    'state',
    'totalBytes'
  ];
  if (Object.keys(value).sort().some((key, index) => key !== keys[index]) ||
      value.schema !== 'dream-maker.storage-volume-health.v1' ||
      value.scope !== 'VOLUME_HEALTH_ONLY' ||
      typeof value.drive !== 'string' || !/^[A-Z]:$/.test(value.drive) ||
      typeof value.checkedAt !== 'string' || !Number.isFinite(Date.parse(value.checkedAt)) ||
      new Date(value.checkedAt).toISOString() !== value.checkedAt) return unknown();

  const text = (candidate: unknown, max: number): candidate is string =>
    typeof candidate === 'string' && candidate.length > 0 && candidate.length <= max && !/[\r\n\0]/.test(candidate);
  const capacity = (candidate: unknown): candidate is number =>
    Number.isSafeInteger(candidate) && Number(candidate) > 0 && Number(candidate) <= Number.MAX_SAFE_INTEGER;

  if (value.state === 'REPAIR_REQUIRED') {
    if (value.evidence !== 'WINDOWS_STORAGE_READ_ONLY' ||
        !text(value.fileSystem, 32) || !text(value.healthStatus, 128) || !text(value.operationalStatus, 128) ||
        !capacity(value.totalBytes) || !Number.isSafeInteger(value.availableBytes) ||
        Number(value.availableBytes) < 0 || Number(value.availableBytes) > Number(value.totalBytes)) return unknown();
    throw new DomainError('STORAGE_VOLUME_REPAIR_REQUIRED', 409);
  }
  if (value.state === 'UNKNOWN') {
    if (value.evidence !== 'PROBE_UNAVAILABLE' || value.fileSystem !== null || value.healthStatus !== null ||
        value.operationalStatus !== null || value.totalBytes !== null || value.availableBytes !== null) return unknown();
    return unknown();
  }
  if (value.state !== 'HEALTHY' ||
      value.evidence !== 'WINDOWS_STORAGE_READ_ONLY' ||
      !text(value.fileSystem, 32) ||
      value.healthStatus !== 'Healthy' ||
      value.operationalStatus !== 'OK' ||
      !capacity(value.totalBytes) ||
      !Number.isSafeInteger(value.availableBytes) ||
      Number(value.availableBytes) < 0 ||
      Number(value.availableBytes) > Number(value.totalBytes)) return unknown();
}
