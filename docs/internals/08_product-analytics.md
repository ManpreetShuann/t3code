# Product analytics

This fork has no product analytics, relay trace export, or mobile crash reporting. The server,
clients, and build scripts contain no analytics service, install identifier, or exporter token,
so there is nothing to opt out of. Do not reintroduce a path that sends usage data off the
machine; OpenTelemetry export stays limited to endpoints the user configures.

Agent feedback reports are stored locally and never delivered. The managed-policy `telemetry`
key is still parsed so existing policy files load, but nothing reads it.
