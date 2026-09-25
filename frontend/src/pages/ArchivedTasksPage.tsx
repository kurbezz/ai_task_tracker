import { useCallback, useEffect, useState } from "react";
import { listArchivedTasks, unarchiveTask } from "../api";
import { STATUS_LABELS, type ArchivedItem } from "../types";
import { useTaskEvents, useTaskEventsReconnect } from "../taskEvents";

function formatArchivedDate(value: string | null) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleDateString([], { dateStyle: "medium" });
}

export function ArchivedTasksPage() {
  const [items, setItems] = useState<ArchivedItem[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState("");

  const loadArchived = useCallback(() => {
    listArchivedTasks().then(setItems).catch((reason: Error) => setError(reason.message)).finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    loadArchived();
  }, [loadArchived]);

  useTaskEvents((event) => {
    if (event.type === "task_updated" || event.type === "task_deleted") loadArchived();
  });
  useTaskEventsReconnect(loadArchived);

  async function restore(taskId: string) {
    setError("");
    setBusyId(taskId);
    try {
      await unarchiveTask(taskId);
      setItems((current) => current.filter((item) => item.id !== taskId));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not restore this task");
    } finally {
      setBusyId("");
    }
  }

  return <section className="page archived-page">
    <div className="page-intro archived-intro">
      <div>
        <p className="eyebrow">The shelf</p>
        <h1>Archived<br /><em>work.</em></h1>
        <p className="lede">Tasks set aside from the board and attention queue. Bring one back whenever it's needed again.</p>
      </div>
      <div className="archived-count"><strong>{items.length}</strong><small>tucked away</small></div>
    </div>
    {error && <div className="error-banner" role="alert">{error}</div>}
    {loading ? <p className="loading-copy">Loading archive…</p> : items.length === 0 ? (
      <div className="empty-state archived-empty"><span className="empty-mark">□</span><p>No archived tasks yet.</p></div>
    ) : (
      <div className="archived-list">
        {items.map((item) => (
          <div className="archived-row" key={item.id}>
            <div className="archived-project">{item.project_name}</div>
            <div className="archived-task">
              <h2>{item.title}</h2>
              <span>{STATUS_LABELS[item.status]}{item.agent ? ` · ${item.agent}` : ""}</span>
            </div>
            <div className="archived-date">
              <span>Archived</span>
              <time>{formatArchivedDate(item.archived_at)}</time>
            </div>
            <button
              className="button button-ghost button-small archived-restore"
              type="button"
              disabled={busyId === item.id}
              onClick={() => void restore(item.id)}
            >
              {busyId === item.id ? "Restoring…" : "Unarchive"}
            </button>
          </div>
        ))}
      </div>
    )}
  </section>;
}
