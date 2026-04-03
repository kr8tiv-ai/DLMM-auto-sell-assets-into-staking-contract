import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from "prom-client";

export const registry = new Registry();

collectDefaultMetrics({ register: registry });

export const crankCycleDuration = new Histogram({
  name: "brain_staking_crank_cycle_duration_seconds",
  help: "Duration of crank cycle in seconds",
  buckets: [0.1, 0.5, 1, 2, 5, 10],
  registers: [registry],
});

export const dlmmExitActiveGauge = new Gauge({
  name: "brain_staking_dlmm_exit_active",
  help: "Number of active DLMM exits",
  registers: [registry],
});

export const crankErrorsTotal = new Counter({
  name: "brain_staking_crank_errors_total",
  help: "Total number of crank errors",
  labelNames: ["error_type"],
  registers: [registry],
});

export const jitoBundleSubmitted = new Counter({
  name: "brain_staking_jito_bundle_submitted_total",
  help: "Total number of Jito bundles submitted",
  registers: [registry],
});

export const jitoBundleSuccess = new Counter({
  name: "brain_staking_jito_bundle_success_total",
  help: "Total number of successful Jito bundles",
  registers: [registry],
});

export const solClaimedTotal = new Counter({
  name: "brain_staking_sol_claimed_total",
  help: "Total SOL claimed from DLMM exits",
  registers: [registry],
});

export const crankLastHeartbeat = new Gauge({
  name: "brain_staking_crank_last_heartbeat_timestamp",
  help: "Unix timestamp of last crank heartbeat",
  registers: [registry],
});

export const rpcCallsTotal = new Counter({
  name: "brain_staking_rpc_calls_total",
  help: "Total number of RPC calls",
  labelNames: ["method"],
  registers: [registry],
});

export function metricsEndpoint(): string {
  return registry.metrics();
}

export function contentType(): string {
  return registry.contentType;
}
