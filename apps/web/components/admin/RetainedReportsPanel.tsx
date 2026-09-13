"use client";

import type {
  RetainedSolverReport,
  RetainedSolverReportPage,
} from "@aerodb/core";
import { Download, Search, X } from "lucide-react";
import { usePathname, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import {
  downloadRetainedReport,
  getRetainedReports,
  isAdminApiError,
} from "@/lib/admin";
import {
  retainedReportFilters,
  retainedReportSearch,
  type RetainedReportFilters,
} from "@/lib/retained-reports";
import styles from "./RetainedReportsPanel.module.css";

function failureMessage(error: unknown) {
  if (isAdminApiError(error) && error.status === 401)
    return "Sign in again to inspect retained reports.";
  if (isAdminApiError(error) && error.status === 403)
    return "Your account cannot access retained reports.";
  return error instanceof Error
    ? error.message
    : "Unable to load retained reports.";
}

export function RetainedReportsPanel() {
  const params = useSearchParams();
  const pathname = usePathname();
  const filters = retainedReportFilters(params.toString());
  const { airfoil, campaignId, includeDelivered, cursor } = filters;
  const [draft, setDraft] = useState(airfoil);
  const [page, setPage] = useState<RetainedSolverReportPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [downloading, setDownloading] = useState<string | null>(null);
  const [downloadError, setDownloadError] = useState<{
    key: string;
    message: string;
  } | null>(null);
  const download = useRef<AbortController | null>(null);
  useEffect(() => setDraft(airfoil), [airfoil]);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    setDownloadError(null);
    getRetainedReports(
      { airfoil, campaignId, includeDelivered, cursor },
      controller.signal,
    )
      .then((result) => {
        if (!controller.signal.aborted) setPage(result);
      })
      .catch((cause) => {
        if (!controller.signal.aborted) setError(failureMessage(cause));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [airfoil, campaignId, includeDelivered, cursor, retry]);
  useEffect(() => () => download.current?.abort(), []);

  const navigate = (next: RetainedReportFilters, push = false) => {
    const search = retainedReportSearch(window.location.search, next);
    window.history[push ? "pushState" : "replaceState"](
      null,
      "",
      `${pathname}${search}`,
    );
  };
  const saveReport = async (report: RetainedSolverReport) => {
    const key = `${report.executionId}:${report.sequence}`;
    const controller = new AbortController();
    download.current?.abort();
    download.current = controller;
    setDownloading(key);
    setDownloadError(null);
    try {
      const blob = await downloadRetainedReport(report, controller.signal);
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `${report.airfoilSlug.replace(/[^a-zA-Z0-9._-]/g, "-")}-solver-report-${report.sequence}.json`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (cause) {
      if (!controller.signal.aborted)
        setDownloadError({ key, message: failureMessage(cause) });
    } finally {
      if (download.current === controller) {
        download.current = null;
        setDownloading(null);
      }
    }
  };
  return (
    <section
      className={styles.panel}
      data-testid="retained-reports"
      aria-labelledby="retained-reports-heading"
    >
      <div className={styles.heading}>
        <h3 id="retained-reports-heading">Retained reports</h3>
        <button
          type="button"
          onClick={() => setRetry((value) => value + 1)}
          disabled={loading}
        >
          Refresh
        </button>
      </div>
      <form
        className={styles.search}
        onSubmit={(event) => {
          event.preventDefault();
          navigate({ ...filters, airfoil: draft.trim(), cursor: "" });
        }}
      >
        <label className={styles.searchInput}>
          <span className={styles.srOnly}>Search reports by profile</span>
          <input
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            maxLength={120}
            placeholder="Profile name or slug"
          />
        </label>
        <button type="submit" aria-label="Search retained reports">
          <Search size={16} />
          <span className={styles.actionLabel}>Search</span>
        </button>
        <button
          type="button"
          aria-label="Clear report filters"
          disabled={
            !airfoil && !campaignId && !includeDelivered && !cursor && !draft
          }
          onClick={() => {
            setDraft("");
            navigate({
              airfoil: "",
              campaignId: "",
              includeDelivered: false,
              cursor: "",
            });
          }}
        >
          <X size={16} />
          <span className={styles.actionLabel}>Clear</span>
        </button>
      </form>
      <div className={styles.filters}>
        <label>
          <input
            type="checkbox"
            checked={includeDelivered}
            onChange={(event) =>
              navigate({
                ...filters,
                includeDelivered: event.target.checked,
                cursor: "",
              })
            }
          />{" "}
          Include fully received reports
        </label>
        {campaignId && (
          <button
            type="button"
            onClick={() => navigate({ ...filters, campaignId: "", cursor: "" })}
          >
            All campaigns
          </button>
        )}
      </div>
      <div aria-busy={loading} aria-live="polite">
        {loading ? (
          <p>Loading retained reports…</p>
        ) : error ? (
          <div role="alert">
            <p>{error}</p>
            <button
              type="button"
              onClick={() => setRetry((value) => value + 1)}
            >
              Retry reports
            </button>
          </div>
        ) : !page?.items.length ? (
          <p>No retained reports match these filters.</p>
        ) : (
          <ul className={styles.list}>
            {page.items.map((report) => {
              const key = `${report.executionId}:${report.sequence}`;
              const pending = Math.max(
                0,
                report.sourceCount - report.receivedSourceCount,
              );
              return (
                <li
                  key={key}
                  className={styles.report}
                  data-testid="retained-report-row"
                >
                  <div className={styles.rowHeading}>
                    <strong>{report.airfoilName}</strong>
                    <button
                      type="button"
                      aria-label={`Download ${report.airfoilName} report ${report.sequence}`}
                      disabled={downloading !== null}
                      onClick={() => void saveReport(report)}
                    >
                      <Download size={16} />
                      <span className={styles.actionLabel}>
                        {downloading === key ? "Downloading…" : "Download"}
                      </span>
                    </button>
                  </div>
                  <div className={styles.context}>
                    {report.campaignId ? (
                      <button
                        type="button"
                        onClick={() =>
                          navigate({
                            ...filters,
                            campaignId: report.campaignId!,
                            cursor: "",
                          })
                        }
                        aria-label={`Filter reports for campaign ${report.campaignName ?? "Unnamed campaign"}`}
                      >
                        {report.campaignName ?? "Unnamed campaign"}
                      </button>
                    ) : (
                      <span>No campaign</span>
                    )}
                    <span>
                      {report.reynolds == null
                        ? "Re —"
                        : `Re ${report.reynolds.toLocaleString()}`}{" "}
                      ·{" "}
                      {report.mach == null
                        ? "Mach —"
                        : `Mach ${report.mach.toPrecision(3)}`}
                    </span>
                  </div>
                  <p className={styles.status}>
                    {pending
                      ? `${pending} of ${report.sourceCount} sources awaiting transfer`
                      : `All ${report.sourceCount} sources received`}
                  </p>
                  <details>
                    <summary>Report details</summary>
                    <dl className={styles.details}>
                      <dt>Received</dt>
                      <dd>
                        <time dateTime={report.receivedAt}>
                          {new Date(report.receivedAt).toLocaleString()}
                        </time>
                      </dd>
                      <dt>Report</dt>
                      <dd>{report.sequence}</dd>
                      <dt>Job state</dt>
                      <dd>{report.jobStatus}</dd>
                      <dt>Angles</dt>
                      <dd>
                        {report.angles.map((angle) => `${angle}°`).join(", ") ||
                          "—"}
                      </dd>
                      <dt>Evidence received</dt>
                      <dd>
                        {report.receivedSourceCount} / {report.sourceCount}
                      </dd>
                      <dt>Recovery</dt>
                      <dd>
                        {report.recovery.queuedAngles} angles queued ·{" "}
                        {report.recovery.claimedAngles} claimed
                      </dd>
                      <dt>Checksum</dt>
                      <dd className={styles.checksum}>{report.signature}</dd>
                    </dl>
                    <p>
                      Receiving a report does not make its coefficients accepted
                      CFD. The download contains the exact retained report.
                    </p>
                  </details>
                  {downloading === key && (
                    <button
                      type="button"
                      onClick={() => download.current?.abort()}
                    >
                      Cancel download
                    </button>
                  )}
                  {downloadError?.key === key && (
                    <p role="alert">{downloadError.message}</p>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
      {!loading && !error && (
        <nav className={styles.pagination} aria-label="Retained report pages">
          <button
            type="button"
            disabled={!cursor}
            onClick={() => navigate({ ...filters, cursor: "" }, true)}
          >
            First page
          </button>
          <span>
            {page?.items.length ?? 0}{" "}
            {page?.items.length === 1 ? "report" : "reports"}
          </span>
          <button
            type="button"
            disabled={!page?.nextCursor}
            onClick={() =>
              navigate({ ...filters, cursor: page?.nextCursor ?? "" }, true)
            }
          >
            Next page
          </button>
        </nav>
      )}
    </section>
  );
}
