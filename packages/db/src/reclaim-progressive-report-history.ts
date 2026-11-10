import { PROGRESSIVE_REPORT_RETENTION_DISABLED } from "./progressive-report-retention";

// Refuse legacy invocations before loading configuration or opening a database.
console.error(PROGRESSIVE_REPORT_RETENTION_DISABLED);
process.exitCode = 1;
