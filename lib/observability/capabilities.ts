import 'server-only';
import { getCapabilities } from '@/lib/config';
import { logObservation } from './logger';

/**
 * A non-throwing view of the capability matrix for the operational scripts and
 * the readiness probe. `lib/config.ts` stays the single source of truth for what
 * a capability needs; this module only decides what may be said out loud.
 *
 * The reported shape never contains a value: a capability is a name, a boolean
 * pair and the NAMES of the variables that are still empty. That is enough for
 * an operator to fix the environment and not enough to leak a key into a log, a
 * status endpoint or a CI transcript.
 */
export type CapabilitySummary = {
  name: string;
  enabled: boolean;
  configured: boolean;
  missing: string[];
};

export function capabilitySummaries(): CapabilitySummary[] {
  return Object.entries(getCapabilities()).map(([name, value]) => ({
    name,
    enabled: value.enabled,
    configured: value.configured,
    missing: [...value.missing],
  }));
}

/** Capabilities that are switched on and fully configured. */
export function readyCapabilities(): string[] {
  return capabilitySummaries().filter((entry) => entry.configured).map((entry) => entry.name);
}

/**
 * Capabilities that are switched on but cannot run. A disabled capability is
 * not listed: it is a deliberate choice, not a broken deployment.
 */
export function brokenCapabilities(): CapabilitySummary[] {
  return capabilitySummaries().filter((entry) => entry.enabled && !entry.configured);
}

/** True when every enabled capability has its configuration. */
export function capabilityMatrixHealthy(): boolean {
  return brokenCapabilities().length === 0;
}

/**
 * Records the matrix in the structured log. Used once by the boot-time script
 * and by `npm run maintenance`, so an operator sees an incomplete environment
 * before a user does. Only enabled-but-broken entries are logged, and only with
 * variable names.
 */
export function reportCapabilities(): CapabilitySummary[] {
  const summaries = capabilitySummaries();
  const broken = summaries.filter((entry) => entry.enabled && !entry.configured);
  for (const entry of broken) {
    logObservation({
      event: 'capability.report',
      module: 'jobs',
      level: 'warn',
      status: 'unavailable',
      maskedErrorCode: 'CAPABILITY_UNCONFIGURED',
      count: entry.missing.length,
    });
  }
  return summaries;
}
