import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { createTask, listProjectTasks, listProjects } from "../api";
import { TaskCard } from "../components/TaskCard";
import { TaskDetail } from "../components/TaskDetail";
import { STATUS_LABELS, STATUS_ORDER, type Project, type Task } from "../types";

export function BoardPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const projectFilter = searchParams.get("project") ?? "";

  const [projects, setProjects] = useState<Project[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [agent, setAgent] = useState("");
  const [taskProjectId, setTaskProjectId] = useState("");
  const [showTaskForm, setShowTaskForm] = useState(false);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const projectsById = useMemo(() => new Map(projects.map((project) => [project.id, project])), [projects]);

  const loadBoard = useCallback(async () => {
    setError("");
    try {
      const nextProjects = await listProjects();
      setProjects(nextProjects);
      const perProject = await Promise.all(nextProjects.map((project) => listProjectTasks(project.id)));
      setTasks(perProject.flat());
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not load the board");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { setLoading(true); void loadBoard(); }, [loadBoard]);

  useEffect(() => {
    if (!taskProjectId && projects.length > 0) {
      setTaskProjectId(projectFilter || projects[0].id);
    }
  }, [projects, projectFilter, taskProjectId]);

  function setProjectFilter(projectId: string) {
    if (projectId) setSearchParams({ project: projectId });
    else setSearchParams({});
  }

  const visibleTasks = projectFilter ? tasks.filter((task) => task.project_id === projectFilter) : tasks;
  const filteredProject = projectFilter ? projectsById.get(projectFilter) : null;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    if (!taskProjectId) {
      setError("Pick a project for this task first");
      return;
    }
    setSaving(true);
    try {
      const task = await createTask({
        project_id: taskProjectId,
        title,
        ...(description.trim() && { description }),
        ...(agent.trim() && { agent }),
      });
      setTasks((current) => [task, ...current]);
      setTitle(""); setDescription(""); setAgent("");
      setShowTaskForm(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not create task");
    } finally { setSaving(false); }
  }

  return (
    <section className="page board-page">
      <div className="board-heading">
        <div>
          <p className="eyebrow">Every project, one board</p>
          <h1>{filteredProject ? filteredProject.name : "All tasks"}</h1>
          {filteredProject?.description && <p className="lede compact-lede">{filteredProject.description}</p>}
        </div>
        <div className="board-heading-side">
          <label className="project-filter">
            <span>Project</span>
            <select value={projectFilter} onChange={(event) => setProjectFilter(event.target.value)}>
              <option value="">All projects</option>
              {projects.map((project) => <option value={project.id} key={project.id}>{project.name}</option>)}
            </select>
          </label>
          <span className="board-stat">{visibleTasks.length} task{visibleTasks.length === 1 ? "" : "s"}</span>
        </div>
      </div>
      {error && <div className="error-banner" role="alert">{error}</div>}
      {!loading && projects.length === 0 ? (
        <div className="empty-state">
          <span className="empty-mark">↗</span>
          <p>No projects yet. <Link to="/projects">Create one</Link> before adding tasks.</p>
        </div>
      ) : showTaskForm ? (
        <form className="task-form surface" onSubmit={submit}>
          <div className="form-heading">
            <div><span className="section-kicker">Add task</span><p>Starts in the TODO column. Move it from the detail panel.</p></div>
            <button className="icon-button" type="button" onClick={() => setShowTaskForm(false)} aria-label="Close new task form">×</button>
          </div>
          <label>Project
            <select value={taskProjectId} onChange={(event) => setTaskProjectId(event.target.value)} required>
              {projects.map((project) => <option value={project.id} key={project.id}>{project.name}</option>)}
            </select>
          </label>
          <label>Task title<input value={title} onChange={(event) => setTitle(event.target.value)} required placeholder="What should the agent take on?" autoFocus /></label>
          <label>Description <span className="optional">optional</span><input value={description} onChange={(event) => setDescription(event.target.value)} placeholder="Short context or acceptance note" /></label>
          <label>Agent <span className="optional">optional</span><input value={agent} onChange={(event) => setAgent(event.target.value)} placeholder="e.g. planner" /></label>
          <button className="button button-primary" disabled={saving}>{saving ? "Adding…" : "Add task"}</button>
        </form>
      ) : (
        <button className="task-form-trigger" type="button" onClick={() => setShowTaskForm(true)}>
          <span className="task-form-trigger-mark">+</span> New task
        </button>
      )}
      {loading ? <p className="loading-copy">Loading board…</p> : <div className="kanban-grid">{STATUS_ORDER.map((status) => {
        const columnTasks = visibleTasks.filter((task) => task.status === status);
        return <section className="kanban-column" key={status}>
          <header><span>{STATUS_LABELS[status]}</span><b>{columnTasks.length}</b></header>
          <div className="kanban-stack">
            {columnTasks.map((task) => (
              <TaskCard
                task={task}
                onSelect={setSelectedTaskId}
                projectName={projectFilter ? undefined : projectsById.get(task.project_id)?.name}
                key={task.id}
              />
            ))}
            {columnTasks.length === 0 && <p className="column-empty">Nothing here</p>}
          </div>
        </section>;
      })}</div>}
      {selectedTaskId && <TaskDetail taskId={selectedTaskId} onClose={() => setSelectedTaskId(null)} onTaskChange={loadBoard} />}
    </section>
  );
}
