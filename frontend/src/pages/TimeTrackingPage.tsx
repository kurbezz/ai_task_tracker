import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import {
  createTimeEntry,
  deleteTimeEntry,
  listProjectTasks,
  listProjects,
  listTimeEntries,
  syncTimeEntries,
  updateTimeEntry,
} from "../api";
import type { Project, Task, TimeEntry, TimeSyncStatus } from "../types";

function todayLocal(): string {
  const now = new Date();
  const offsetMs = now.getTimezoneOffset() * 60000;
  return new Date(now.getTime() - offsetMs).toISOString().slice(0, 10);
}

function formatHours(minutes: number): string {
  const hours = Math.round((minutes / 60) * 100) / 100;
  return String(hours);
}

function formatRelative(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return iso;
  const diffMin = Math.round((Date.now() - then) / 60000);
  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin} minute${diffMin === 1 ? "" : "s"} ago`;
  const diffHour = Math.round(diffMin / 60);
  if (diffHour < 24) return `${diffHour} hour${diffHour === 1 ? "" : "s"} ago`;
  const diffDay = Math.round(diffHour / 24);
  if (diffDay < 7) return `${diffDay} day${diffDay === 1 ? "" : "s"} ago`;
  return new Date(iso).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}

export function TimeTrackingPage() {
  const [date, setDate] = useState(() => todayLocal());
  const [entries, setEntries] = useState<TimeEntry[]>([]);
  const [sync, setSync] = useState<TimeSyncStatus | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectTasks, setProjectTasks] = useState<Task[]>([]);
  const [formProjectId, setFormProjectId] = useState("");
  const [formTaskId, setFormTaskId] = useState("");
  const [hours, setHours] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editHours, setEditHours] = useState("");
  const [rowBusy, setRowBusy] = useState("");
  const [syncBusy, setSyncBusy] = useState(false);
  const [syncError, setSyncError] = useState("");
  const [notConfigured, setNotConfigured] = useState(false);

  const loadEntries = useCallback(async (forDate: string) => {
    setError("");
    try {
      const result = await listTimeEntries(forDate);
      setEntries(result.entries);
      setSync(result.sync);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not load time entries");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    setLoading(true);
    setNotConfigured(false);
    setSyncError("");
    void loadEntries(date);
  }, [date, loadEntries]);

  useEffect(() => {
    listProjects().then(setProjects).catch(() => {});
  }, []);

  useEffect(() => {
    if (!formProjectId && projects.length > 0) setFormProjectId(projects[0].id);
  }, [projects, formProjectId]);

  useEffect(() => {
    if (!formProjectId) {
      setProjectTasks([]);
      setFormTaskId("");
      return;
    }
    listProjectTasks(formProjectId)
      .then((tasks) => {
        setProjectTasks(tasks);
        setFormTaskId((current) => (tasks.some((task) => task.id === current) ? current : tasks[0]?.id ?? ""));
      })
      .catch(() => setProjectTasks([]));
  }, [formProjectId]);

  const totalHoursLabel = useMemo(() => {
    const totalMinutes = entries.reduce((sum, entry) => sum + entry.minutes, 0);
    return formatHours(totalMinutes);
  }, [entries]);

  async function submitEntry(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    if (!formTaskId) {
      setError("Pick a task first");
      return;
    }
    const parsedHours = Number(hours);
    if (!Number.isFinite(parsedHours) || parsedHours <= 0) {
      setError("Enter hours greater than 0");
      return;
    }
    setSaving(true);
    try {
      const entry = await createTimeEntry({
        task_id: formTaskId,
        entry_date: date,
        minutes: Math.round(parsedHours * 60),
      });
      setEntries((current) => [...current, entry]);
      setHours("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not add time entry");
    } finally {
      setSaving(false);
    }
  }

  function startEdit(entry: TimeEntry) {
    setError("");
    setEditingId(entry.id);
    setEditHours(formatHours(entry.minutes));
  }

  async function saveEdit(entry: TimeEntry) {
    const parsedHours = Number(editHours);
    if (!Number.isFinite(parsedHours) || parsedHours <= 0) {
      setError("Enter hours greater than 0");
      return;
    }
    setError("");
    setRowBusy(entry.id);
    try {
      const updated = await updateTimeEntry(entry.id, { minutes: Math.round(parsedHours * 60) });
      setEntries((current) => current.map((item) => (item.id === entry.id ? updated : item)));
      setEditingId(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not update entry");
    } finally {
      setRowBusy("");
    }
  }

  async function removeEntry(entry: TimeEntry) {
    if (!window.confirm(`Delete the ${formatHours(entry.minutes)}h entry for "${entry.task_title}"?`)) return;
    setError("");
    setRowBusy(entry.id);
    try {
      await deleteTimeEntry(entry.id);
      setEntries((current) => current.filter((item) => item.id !== entry.id));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not delete entry");
    } finally {
      setRowBusy("");
    }
  }

  async function handleSync() {
    setSyncBusy(true);
    setSyncError("");
    setNotConfigured(false);
    try {
      const status = await syncTimeEntries(date);
      setSync(status);
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : "Could not sync to Clockify";
      if (/not configured/i.test(message)) setNotConfigured(true);
      else setSyncError(message);
    } finally {
      setSyncBusy(false);
    }
  }

  return (
    <section className="page time-page">
      <div className="time-heading">
        <div>
          <p className="eyebrow">Manual logging, daily sync</p>
          <h1>Time<br /><em>tracking.</em></h1>
          <p className="lede">Log hours per task for the day, then push one combined entry to Clockify.</p>
        </div>
        <div className="time-total-mark">
          <span>{date === todayLocal() ? "today" : "this day"}</span>
          <strong>{totalHoursLabel}h</strong>
          <small>logged</small>
        </div>
      </div>

      <label className="date-picker-field">
        Date
        <input type="date" value={date} max={todayLocal()} onChange={(event) => setDate(event.target.value)} />
      </label>

      {error && <div className="error-banner" role="alert">{error}</div>}

      <div className="time-layout">
        <div className="time-main">
          <form className="time-entry-form surface" onSubmit={submitEntry}>
            <div className="form-heading">
              <div><span className="section-kicker">Log time</span><p>Pick a task, add the hours you spent.</p></div>
              <span className="form-star">✦</span>
            </div>
            <label>Project
              <select value={formProjectId} onChange={(event) => setFormProjectId(event.target.value)}>
                {projects.map((project) => <option value={project.id} key={project.id}>{project.name}</option>)}
              </select>
            </label>
            <label>Task
              <select
                value={formTaskId}
                onChange={(event) => setFormTaskId(event.target.value)}
                disabled={projectTasks.length === 0}
                required
              >
                {projectTasks.length === 0 && <option value="">No tasks in this project</option>}
                {projectTasks.map((task) => <option value={task.id} key={task.id}>{task.title}</option>)}
              </select>
            </label>
            <label>Hours
              <input
                type="number"
                step="0.25"
                min="0.25"
                placeholder="1.5"
                value={hours}
                onChange={(event) => setHours(event.target.value)}
                required
              />
            </label>
            <button className="button button-primary" disabled={saving || !formTaskId}>
              {saving ? "Adding…" : "Add entry"}
            </button>
          </form>

          {loading ? (
            <p className="loading-copy">Loading entries…</p>
          ) : entries.length === 0 ? (
            <div className="empty-state">
              <span className="empty-mark">+</span>
              <p>No time logged for this day yet. Add your first entry above.</p>
            </div>
          ) : (
            <div className="time-entry-list">
              {entries.map((entry) => (
                <div className="time-entry-row" key={entry.id}>
                  <span className="time-entry-task">{entry.task_title}</span>
                  {editingId === entry.id ? (
                    <form
                      className="time-entry-edit"
                      onSubmit={(event) => { event.preventDefault(); void saveEdit(entry); }}
                    >
                      <input
                        type="number"
                        step="0.25"
                        min="0.25"
                        autoFocus
                        value={editHours}
                        onChange={(event) => setEditHours(event.target.value)}
                      />
                      <button className="button button-small button-secondary" disabled={rowBusy === entry.id}>
                        {rowBusy === entry.id ? "Saving…" : "Save"}
                      </button>
                      <button
                        className="button button-small button-ghost"
                        type="button"
                        onClick={() => setEditingId(null)}
                      >
                        Cancel
                      </button>
                    </form>
                  ) : (
                    <button className="time-entry-hours" type="button" onClick={() => startEdit(entry)}>
                      {formatHours(entry.minutes)}h
                    </button>
                  )}
                  <button
                    className="icon-button time-entry-delete"
                    type="button"
                    aria-label={`Delete entry for ${entry.task_title}`}
                    disabled={rowBusy === entry.id}
                    onClick={() => void removeEntry(entry)}
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        <aside className="time-sync-panel surface">
          <div className="form-heading">
            <div><span className="section-kicker">Clockify</span><p>One combined entry per day.</p></div>
          </div>
          {sync?.is_synced ? (
            <p className="sync-status sync-status-ok">
              <span className="sync-dot" />Synced {sync.synced_at ? formatRelative(sync.synced_at) : ""}
            </p>
          ) : (
            <p className="sync-status"><span className="sync-dot sync-dot-idle" />Not synced yet</p>
          )}
          {notConfigured && (
            <div className="sync-note">
              <strong>Clockify isn't connected yet.</strong>
              <p>Add the Clockify env vars on the backend to enable syncing. Your logged hours stay saved locally either way.</p>
            </div>
          )}
          {syncError && <div className="error-banner" role="alert">{syncError}</div>}
          <button
            className="button button-secondary"
            type="button"
            disabled={syncBusy || entries.length === 0}
            onClick={() => void handleSync()}
          >
            {syncBusy ? "Syncing…" : "Sync to Clockify"}
          </button>
          {entries.length === 0 && <p className="field-note">Log at least one entry before syncing.</p>}
        </aside>
      </div>
    </section>
  );
}
