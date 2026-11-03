/** Only the CLI owns an SDK; embedded servers use their host's provider. */
export async function startTelemetry(): Promise<() => Promise<void>> {
  if (
    !process.env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim() ||
    process.env.OTEL_SDK_DISABLED?.toLowerCase() === 'true'
  ) {
    return async () => {};
  }

  const [{ NodeSDK }, { OTLPTraceExporter }, { W3CTraceContextPropagator }] =
    await Promise.all([
      import('@opentelemetry/sdk-node'),
      import('@opentelemetry/exporter-trace-otlp-http'),
      import('@opentelemetry/core'),
    ]);
  const sdk = new NodeSDK({
    // Process resource detection includes command-line arguments (API keys).
    autoDetectResources: false,
    serviceName: process.env.OTEL_SERVICE_NAME?.trim() || 'rawtree-mcp',
    textMapPropagator: new W3CTraceContextPropagator(),
    traceExporter: new OTLPTraceExporter(),
    logRecordProcessors: [],
    metricReaders: [],
  });
  sdk.start();

  let shutdown: Promise<void> | undefined;
  return () => {
    shutdown ??= sdk.shutdown().catch(() => {
      // Exporter errors can include collector URLs and headers.
      console.error('OpenTelemetry shutdown failed.');
    });
    return shutdown;
  };
}
