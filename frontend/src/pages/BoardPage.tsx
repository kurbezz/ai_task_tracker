import { FormEvent, useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { createTask, listProjectTasks, listProjects } from "../api";
import { TaskCard } from "../components/TaskCard";
import { TaskDetail } from "../components/TaskDetail";
import { STATUS_LABELS, STATUS_ORDER, type Project, type Task } from "../types";

export function BoardPage() {
  const { projectId = "" } = useParams();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [project, setProject] = useState<Project | null>(null);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [agent, setAgent] = useState("");
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const loadBoard = useCallback(async () => {
    setError("");
    try {
      const [nextTasks, projects] = await Promise.all([listProjectTasks(projectId), listProjects()]);
      setTasks(nextTasks);
      setProject(projects.find((item) => item.id === projectId) ?? null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not load this board");
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => { setLoading(true); void loadBoard(); }, [loadBoard]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setSaving(true);
    try {
      const task = await createTask({ project_id: projectId, title, ...(description.trim() && { description }), ...(agent.trim() && { agent }) });
      setTasks((current) => [task, ...current]);
      setTitle(""); setDescription(""); setAgent("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not create task");
    } finally { setSaving(false); }
  }

  return (
    <section className="page board-page">
      <div className="board-heading"><div><Link className="back-link" to="/">← All projects</Link><p className="eyebrow">Project board</p><h1>{project?.name || "Project workspace"}</h1>{project?.description && <p className="lede compact-lede">{project.description}</p>}</div><span className="board-stat">{tasks.length} task{tasks.length === 1 ? "" : "s"}</span></div>
      {error && <div className="error-banner" role="alert">{error}</div>}
      <form className="task-form surface" onSubmit={submit}>
        <div className="form-heading"><div><span className="section-kicker">Add task</span><p>Start work in the TODO column. Move it from the detail panel.</p></div></div>
        <label>Task title<input value={title} onChange={(event) => setTitle(event.target.value)} required placeholder="What should the agent take on?" /></label>
        <label>Description <span className="optional">optional</span><input value={description} onChange={(event) => setDescription(event.target.value)} placeholder="Short context or acceptance note" /></label>
        <label>Agent <span className="optional">optional</span><input value={agent} onChange={(event) => setAgent(event.target.value)} placeholder="e.g. planner" /></label>
        <button className="button button-primary" disabled={saving}>{saving ? "Adding…" : "Add task"}</button>
      </form>
      {loading ? <p className="loading-copy">Loading board…</p> : <div className="kanban-grid">{STATUS_ORDER.map((status) => {
        const columnTasks = tasks.filter((task) => task.status === status);
        return <section className="kanban-column" key={status}><header><span>{STATUS_LABELS[status]}</span><b>{columnTasks.length}</b></header><div className="kanban-stack">{columnTasks.map((task) => <TaskCard task={task} onSelect={setSelectedTaskId} key={task.id} />)}{columnTasks.length === 0 && <p className="column-empty">Nothing here</p>}</div></section>;
      })}</div>}
      {selectedTaskId && <TaskDetail taskId={selectedTaskId} onClose={() => setSelectedTaskId(null)} onTaskChange={loadBoard} />}
    </section>
  );
}
