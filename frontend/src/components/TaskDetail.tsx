import { FormEvent, useEffect, useState } from "react";
import { addLog, addTag, deleteTask, getTask, listLogs, removeTag, transitionTask, updateTask } from "../api";
import { STATUS_LABELS, STATUS_ORDER, type Status, type Task, type TaskLog } from "../types";
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
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [agent, setAgent] = useState("");
  const [result, setResult] = useState("");
  const [sourceUrl, setSourceUrl] = useState("");
  const [prUrl, setPrUrl] = useState("");
  const [logAuthor, setLogAuthor] = useState("");
  const [logMessage, setLogMessage] = useState("");
  const [tagName, setTagName] = useState("");
  const [busy, setBusy] = useState("");
  const [copied, setCopied] = useState(false);

  async function refresh() {
    const [nextTask, nextLogs] = await Promise.all([getTask(taskId), listLogs(taskId)]);
    setTask(nextTask);
    setLogs(nextLogs);
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

  function submitLog(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    mutate("add-log", () => addLog(taskId, { author: logAuthor, message: logMessage }));
  }

  function submitTag(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    mutate("add-tag", () => addTag(taskId, tagName));
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
            <h2 className="detail-title">{task.title}</h2>
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

          <section className="detail-section"><h3>Brief</h3><p className="detail-description">{task.description || "No description has been added."}</p></section>

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

          <section className="detail-section"><h3>Timeline</h3>
            <form className="log-form" onSubmit={submitLog}><input value={logAuthor} onChange={(event) => setLogAuthor(event.target.value)} required placeholder="Author" /><textarea rows={3} value={logMessage} onChange={(event) => setLogMessage(event.target.value)} required placeholder="Add a progress update" /><button className="button button-primary" disabled={busy !== ""}>{busy === "add-log" ? "Posting…" : "Post update"}</button></form>
            <ol className="timeline">{logs.length ? logs.map((log) => <li key={log.id}><div><strong>{log.author}</strong><time>{formatDate(log.created_at)}</time></div><p>{log.message}</p></li>) : <li className="muted">No updates yet.</li>}</ol>
          </section>
        </>}
      </aside>
    </div>
  );
}
