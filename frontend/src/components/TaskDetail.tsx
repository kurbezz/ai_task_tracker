import { FormEvent, useEffect, useState } from "react";
import { addLog, addTag, createTimeEntry, deleteTask, deleteTimeEntry, getTask, listLogs, listTaskTimeEntries, removeTag, transitionTask, updateTask, updateTimeEntry } from "../api";
import { formatHours, todayLocal } from "../timeFormat";
import { STATUS_LABELS, STATUS_ORDER, type Status, type Task, type TaskLog, type TimeEntry } from "../types";
import { useTaskEvents, useTaskEventsReconnect } from "../taskEvents";
import { TagBadge } from "./TagBadge";

interface TaskDetailProps {
  taskId: string;
  onClose: () => void;
  onTaskChange: () => Promise<void> | void;
}

function formatDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}

export function TaskDetail({ taskId, onClose, onTaskChange }: TaskDetailProps) {
  const [task, setTask] = useState<Task | null>(null);
  const [logs, setLogs] = useState<TaskLog[]>([]);
  const [timeEntries, setTimeEntries] = useState<TimeEntry[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [agent, setAgent] = useState("");
  const [result, setResult] = useState("");
  const [sourceUrl, setSourceUrl] = useState("");
  const [prUrl, setPrUrl] = useState("");
  const [logAuthor, setLogAuthor] = useState("");
  const [logMessage, setLogMessage] = useState("");
  const [tagName, setTagName] = useState("");
  const [timeHours, setTimeHours] = useState("");
  const [busy, setBusy] = useState("");
  const [timeSaving, setTimeSaving] = useState(false);
  const [editingTimeEntryId, setEditingTimeEntryId] = useState<string | null>(null);
  const [editTimeHours, setEditTimeHours] = useState("");
  const [timeEntryBusy, setTimeEntryBusy] = useState("");
  const [copied, setCopied] = useState(false);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const [editingDescription, setEditingDescription] = useState(false);
  const [descriptionDraft, setDescriptionDraft] = useState("");

  async function refresh() {
    const [nextTask, nextLogs, nextTimeEntries] = await Promise.all([getTask(taskId), listLogs(taskId), listTaskTimeEntries(taskId)]);
    setTask(nextTask);
    setLogs(nextLogs);
    setTimeEntries(nextTimeEntries.entries);
    setAgent(nextTask.agent ?? "");
    setResult(nextTask.result_summary ?? "");
    setSourceUrl(nextTask.source_url ?? "");
    setPrUrl(nextTask.pr_url ?? "");
  }

  useEffect(() => {
    setLoading(true);
    setError("");
    refresh().catch((reason: Error) => setError(reason.message)).finally(() => setLoading(false));
  // Refreshes whenever a different card is opened.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId]);

  useTaskEvents((event) => {
    if (event.type === "task_updated" && event.task.id === taskId) {
      setTask((current) => current ? { ...current, ...event.task } : event.task);
      setAgent(event.task.agent ?? "");
      setResult(event.task.result_summary ?? "");
      setSourceUrl(event.task.source_url ?? "");
      setPrUrl(event.task.pr_url ?? "");
    } else if (event.type === "log_added" && event.task_id === taskId) {
      setLogs((current) => [...current, event.log]);
    } else if (event.type === "task_deleted" && event.task_id === taskId) {
      onClose();
    }
  });

  useTaskEventsReconnect(() => {
    void refresh().catch((reason) => setError(reason instanceof Error ? reason.message : "Could not load task"));
  });

  async function mutate(action: string, operation: () => Promise<unknown>, keepInput = false, afterSuccess?: () => Promise<void> | void) {
    setError("");
    setBusy(action);
    try {
      await operation();
      if (afterSuccess) {
        await afterSuccess();
      } else {
        await refresh();
        await onTaskChange();
      }
      if (!keepInput && action === "add-log") { setLogAuthor(""); setLogMessage(""); }
      if (!keepInput && action === "add-tag") setTagName("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not save this change");
    } finally {
      setBusy("");
    }
  }

  function saveDetails(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    mutate("save", () => updateTask(taskId, {
      agent: agent.trim() || null,
      result_summary: result.trim() || null,
      source_url: sourceUrl.trim() || null,
      pr_url: prUrl.trim() || null,
    }), true);
  }

  function startEditTitle() {
    if (!task) return;
    setError("");
    setTitleDraft(task.title);
    setEditingTitle(true);
  }

  function cancelEditTitle() {
    setEditingTitle(false);
    setError("");
  }

  function saveTitleEdit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = titleDraft.trim();
    if (!trimmed) {
      setError("Title is required");
      return;
    }
    mutate("save-title", () => updateTask(taskId, { title: trimmed }), true, async () => {
      await refresh();
      await onTaskChange();
      setEditingTitle(false);
    });
  }

  function startEditDescription() {
    if (!task) return;
    setError("");
    setDescriptionDraft(task.description ?? "");
    setEditingDescription(true);
  }

  function cancelEditDescription() {
    setEditingDescription(false);
    setError("");
  }

  function saveDescriptionEdit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    mutate("save-description", () => updateTask(taskId, { description: descriptionDraft.trim() || null }), true, async () => {
      await refresh();
      await onTaskChange();
      setEditingDescription(false);
    });
  }

  function submitLog(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    mutate("add-log", () => addLog(taskId, { author: logAuthor, message: logMessage }));
  }

  function submitTag(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    mutate("add-tag", () => addTag(taskId, tagName));
  }

  async function submitTimeEntry(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const parsedHours = Number(timeHours);
    if (!Number.isFinite(parsedHours) || parsedHours <= 0) {
      setError("Enter hours greater than 0");
      return;
    }
    setError("");
    setTimeSaving(true);
    try {
      const entry = await createTimeEntry({ task_id: taskId, entry_date: todayLocal(), minutes: Math.round(parsedHours * 60) });
      setTimeEntries((current) => [entry, ...current]);
      setTimeHours("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not add time entry");
    } finally {
      setTimeSaving(false);
    }
  }

  function startTimeEntryEdit(entry: TimeEntry) {
    setError("");
    setEditingTimeEntryId(entry.id);
    setEditTimeHours(formatHours(entry.minutes));
  }

  async function saveTimeEntryEdit(entry: TimeEntry) {
    const parsedHours = Number(editTimeHours);
    if (!Number.isFinite(parsedHours) || parsedHours <= 0) {
      setError("Enter hours greater than 0");
      return;
    }
    setError("");
    setTimeEntryBusy(entry.id);
    try {
      const updated = await updateTimeEntry(entry.id, { minutes: Math.round(parsedHours * 60) });
      setTimeEntries((current) => current.map((item) => (item.id === entry.id ? updated : item)));
      setEditingTimeEntryId(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not update entry");
    } finally {
      setTimeEntryBusy("");
    }
  }

  async function removeTimeEntry(entry: TimeEntry) {
    if (!window.confirm(`Delete the ${formatHours(entry.minutes)}h entry for "${entry.task_title}"?`)) return;
    setError("");
    setTimeEntryBusy(entry.id);
    try {
      await deleteTimeEntry(entry.id);
      setTimeEntries((current) => current.filter((item) => item.id !== entry.id));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not delete entry");
    } finally {
      setTimeEntryBusy("");
    }
  }

  function removeTask() {
    if (!window.confirm("Delete this task? This cannot be undone.")) return;
    mutate("delete", () => deleteTask(taskId), true, async () => {
      onClose();
      await onTaskChange();
    });
  }

  async function copyTaskCommand() {
    const command = `/tt ${taskId}`;
    try {
      await navigator.clipboard.writeText(command);
    } catch {
      window.prompt("Copy the command below:", command);
      return;
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  }

  const currentIndex = task ? STATUS_ORDER.indexOf(task.status) : 0;
  const allowedStatuses = task ? STATUS_ORDER.slice(0, Math.min(currentIndex + 2, STATUS_ORDER.length)) : [];

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <aside className="detail-panel" role="dialog" aria-modal="true" aria-label="Task details" onMouseDown={(event) => event.stopPropagation()}>
        <div className="detail-topline"><span className="section-kicker">Task detail</span><button className="icon-button" type="button" onClick={onClose} aria-label="Close task detail">×</button></div>
        {loading ? <p className="loading-copy">Loading task…</p> : !task ? <div className="error-banner" role="alert">{error || "Task could not be loaded."}</div> : <>
          <div className="detail-title-row">
            {editingTitle ? (
              <form className="title-edit-form" onSubmit={saveTitleEdit}>
                <input className="title-edit-input" value={titleDraft} onChange={(event) => setTitleDraft(event.target.value)} required autoFocus />
                <button className="button button-primary button-small" disabled={busy === "save-title"}>{busy === "save-title" ? "Saving…" : "Save"}</button>
                <button className="button button-ghost button-small" type="button" onClick={cancelEditTitle}>Cancel</button>
              </form>
            ) : (
              <>
                <h2 className="detail-title">{task.title}</h2>
                <button className="button button-ghost button-small" type="button" onClick={startEditTitle}>Edit</button>
              </>
            )}
            <button
              className="copy-command-button"
              type="button"
              onClick={copyTaskCommand}
              aria-label={`Copy command /tt ${taskId}`}
            >
              {copied ? "Copied!" : `/tt ${taskId}`}
            </button>
          </div>
          {error && <div className="error-banner detail-error" role="alert">{error}</div>}

          <section className="detail-section workflow-section">
            <label className="field-label" htmlFor="task-status">Workflow stage</label>
            <select id="task-status" value={task.status} disabled={busy !== ""} onChange={(event) => mutate("status", () => transitionTask(taskId, event.target.value as Status), true)}>
              {allowedStatuses.map((status) => <option key={status} value={status}>{STATUS_LABELS[status]}</option>)}
            </select>
            <p className="field-note">Move forward one stage, or return work to an earlier stage.</p>
          </section>

          <section className="detail-section">
            <h3>Brief</h3>
            {editingDescription ? (
              <form className="edit-form" onSubmit={saveDescriptionEdit}>
                <textarea rows={4} value={descriptionDraft} onChange={(event) => setDescriptionDraft(event.target.value)} placeholder="Describe the task" autoFocus />
                <div className="detail-description-actions">
                  <button className="button button-primary button-small" disabled={busy === "save-description"}>{busy === "save-description" ? "Saving…" : "Save"}</button>
                  <button className="button button-ghost button-small" type="button" onClick={cancelEditDescription}>Cancel</button>
                </div>
              </form>
            ) : (
              <>
                <p className="detail-description">{task.description || "No description has been added."}</p>
                <button className="button button-ghost button-small detail-edit-trigger" type="button" onClick={startEditDescription}>Edit</button>
              </>
            )}
          </section>

          <form className="detail-section edit-form" onSubmit={saveDetails}>
            <h3>Assignment & outcome</h3>
            <label>Agent<input value={agent} onChange={(event) => setAgent(event.target.value)} placeholder="e.g. coding-agent" /></label>
            <label>Result summary<textarea rows={3} value={result} onChange={(event) => setResult(event.target.value)} placeholder="What did the work produce?" /></label>
            <label>Source link<input value={sourceUrl} onChange={(event) => setSourceUrl(event.target.value)} placeholder="https://…" />{task.source_url && <a href={task.source_url} target="_blank" rel="noreferrer">Open ↗</a>}</label>
            <label>PR link<input value={prUrl} onChange={(event) => setPrUrl(event.target.value)} placeholder="https://…" />{task.pr_url && <a href={task.pr_url} target="_blank" rel="noreferrer">Open ↗</a>}</label>
            <button className="button button-secondary" disabled={busy !== ""}>{busy === "save" ? "Saving…" : "Save details"}</button>
            <button className="button button-quiet" type="button" disabled={busy !== ""} onClick={removeTask}>{busy === "delete" ? "Deleting…" : "Delete task"}</button>
          </form>

          <section className="detail-section"><h3>Tags</h3>
            <div className="tag-manager">{task.tags.length ? task.tags.map((tag) => <span className="tag-with-remove" key={tag.id}><TagBadge tag={tag} /><button type="button" aria-label={`Remove ${tag.name}`} disabled={busy !== ""} onClick={() => mutate("remove-tag", () => removeTag(taskId, tag.id), true)}>×</button></span>) : <p className="muted">No tags yet.</p>}</div>
            <form className="inline-form" onSubmit={submitTag}><input value={tagName} onChange={(event) => setTagName(event.target.value)} required placeholder="Add a tag" /><button className="button button-secondary" disabled={busy !== ""}>{busy === "add-tag" ? "Adding…" : "Add"}</button></form>
          </section>

          <section className="detail-section"><h3>Time logged</h3>
            <form className="time-entry-edit" onSubmit={submitTimeEntry}>
              <input type="number" step="0.25" min="0.25" placeholder="1.5" value={timeHours} onChange={(event) => setTimeHours(event.target.value)} required />
              <button className="button button-small button-secondary" disabled={timeSaving}>{timeSaving ? "Adding…" : "Add"}</button>
            </form>
            {timeEntries.length === 0 ? <p className="muted">No time logged yet for this task.</p> : <div className="time-entry-list">
              {timeEntries.map((entry) => <div className="time-entry-row" key={entry.id}>
                <span className="time-entry-task">{entry.entry_date}</span>
                {editingTimeEntryId === entry.id ? <form className="time-entry-edit" onSubmit={(event) => { event.preventDefault(); void saveTimeEntryEdit(entry); }}>
                  <input type="number" step="0.25" min="0.25" autoFocus value={editTimeHours} onChange={(event) => setEditTimeHours(event.target.value)} />
                  <button className="button button-small button-secondary" disabled={timeEntryBusy === entry.id}>{timeEntryBusy === entry.id ? "Saving…" : "Save"}</button>
                  <button className="button button-small button-ghost" type="button" onClick={() => setEditingTimeEntryId(null)}>Cancel</button>
                </form> : <button className="time-entry-hours" type="button" onClick={() => startTimeEntryEdit(entry)}>{formatHours(entry.minutes)}h</button>}
                <button className="icon-button time-entry-delete" type="button" aria-label={`Delete entry for ${entry.task_title}`} disabled={timeEntryBusy === entry.id} onClick={() => void removeTimeEntry(entry)}>×</button>
              </div>)}
            </div>}
          </section>

          <section className="detail-section"><h3>Timeline</h3>
            <form className="log-form" onSubmit={submitLog}><input value={logAuthor} onChange={(event) => setLogAuthor(event.target.value)} required placeholder="Author" /><textarea rows={3} value={logMessage} onChange={(event) => setLogMessage(event.target.value)} required placeholder="Add a progress update" /><button className="button button-primary" disabled={busy !== ""}>{busy === "add-log" ? "Posting…" : "Post update"}</button></form>
            <ol className="timeline">{logs.length ? logs.map((log) => <li key={log.id}><div><strong>{log.author}</strong><time>{formatDate(log.created_at)}</time></div><p>{log.message}</p></li>) : <li className="muted">No updates yet.</li>}</ol>
          </section>
        </>}
      </aside>
    </div>
  );
}
