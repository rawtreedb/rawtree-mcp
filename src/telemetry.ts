import { context, defaultTextMapSetter } from '@opentelemetry/api';
import { W3CTraceContextPropagator } from '@opentelemetry/core';

const propagator = new W3CTraceContextPropagator();

/** Carry trace context to the API without forwarding baggage. */
export function traceContextHeaders(): Record<string, string> {
  const headers: Record<string, string> = {};
  propagator.inject(context.active(), headers, defaultTextMapSetter);
  return headers;
}
