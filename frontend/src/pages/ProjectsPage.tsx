import { FormEvent, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { createProject, deleteProject, listProjects, updateProject } from "../api";
import type { Project } from "../types";

export function ProjectsPage() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [editError, setEditError] = useState("");
  const [editSaving, setEditSaving] = useState(false);

  useEffect(() => {
    listProjects()
      .then(setProjects)
      .catch((reason: Error) => setError(reason.message))
      .finally(() => setLoading(false));
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setSaving(true);
    try {
      const project = await createProject({ name, ...(description.trim() && { description }) });
      setProjects((current) => [project, ...current]);
      setName("");
      setDescription("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not create project");
    } finally {
      setSaving(false);
    }
  }

  function startEdit(project: Project) {
    setEditingId(project.id);
    setEditName(project.name);
    setEditDescription(project.description ?? "");
    setEditError("");
  }

  function cancelEdit() {
    setEditingId(null);
    setEditError("");
  }

  async function saveEdit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editingId) return;
    setEditError("");
    setEditSaving(true);
    try {
      const updated = await updateProject(editingId, {
        name: editName,
        description: editDescription.trim() ? editDescription : null,
      });
      setProjects((current) => current.map((project) => (project.id === updated.id ? updated : project)));
      setEditingId(null);
    } catch (reason) {
      setEditError(reason instanceof Error ? reason.message : "Could not save changes");
    } finally {
      setEditSaving(false);
    }
  }

  async function removeProject(projectId: string) {
    if (!window.confirm("Delete this project? Its tasks stay linked to it and will no longer be reachable.")) return;
    setEditError("");
    try {
      await deleteProject(projectId);
      setProjects((current) => current.filter((project) => project.id !== projectId));
      setEditingId(null);
    } catch (reason) {
      setEditError(reason instanceof Error ? reason.message : "Could not delete project");
    }
  }

  return (
    <section className="page projects-page">
      <div className="page-intro intro-split">
        <div>
          <p className="eyebrow">Workspace</p>
          <h1>Keep AI work<br /><em>moving forward.</em></h1>
          <p className="lede">Create a project, then follow every agent task from the first question to delivery.</p>
        </div>
        <form className="project-form surface" onSubmit={submit}>
          <div className="form-heading"><span className="section-kicker">New project</span><span className="form-star">✦</span></div>
          <label>Project name<input value={name} onChange={(event) => setName(event.target.value)} required placeholder="e.g. Product site refresh" /></label>
          <label>Description <span className="optional">optional</span><textarea rows={2} value={description} onChange={(event) => setDescription(event.target.value)} placeholder="What is this work for?" /></label>
          <button className="button button-primary" disabled={saving}>{saving ? "Creating…" : "Create project"}</button>
        </form>
      </div>

      {error && <div className="error-banner" role="alert">{error}</div>}
      <div className="section-heading"><div><p className="eyebrow">Your projects</p><h2>Active work</h2></div><span className="count-chip">{projects.length}</span></div>
      {editError && <div className="error-banner" role="alert">{editError}</div>}
      {loading ? <p className="loading-copy">Loading projects…</p> : projects.length === 0 ? (
        <div className="empty-state"><span className="empty-mark">↗</span><p>No projects yet. Create one to start tracking AI work.</p></div>
      ) : (
        <div className="project-list">
          {projects.map((project, index) =>
            editingId === project.id ? (
              <form className="project-row project-row-editing" onSubmit={saveEdit} key={project.id}>
                <span className="project-number">0{index + 1}</span>
                <div className="project-row-edit-fields">
                  <input value={editName} onChange={(event) => setEditName(event.target.value)} required placeholder="Project name" autoFocus />
                  <textarea rows={2} value={editDescription} onChange={(event) => setEditDescription(event.target.value)} placeholder="What is this work for?" />
                </div>
                <div className="project-row-actions project-row-edit-actions">
                  <button className="button button-primary button-small" disabled={editSaving}>{editSaving ? "Saving…" : "Save"}</button>
                  <button className="button button-ghost button-small" type="button" onClick={cancelEdit}>Cancel</button>
                  <button className="button button-quiet button-small" type="button" onClick={() => removeProject(project.id)}>Delete</button>
                </div>
              </form>
            ) : (
              <div className="project-row" key={project.id}>
                <Link className="project-row-link" to={`/?project=${project.id}`}>
                  <span className="project-number">0{index + 1}</span>
                  <div className="project-row-info"><h3>{project.name}</h3><p>{project.description || "No description yet."}</p></div>
                </Link>
                <div className="project-row-actions">
                  <button className="button button-ghost button-small" type="button" onClick={() => startEdit(project)}>Edit</button>
                  <Link className="project-row-arrow" to={`/?project=${project.id}`} aria-hidden="true">→</Link>
                </div>
              </div>
            ),
          )}
        </div>
      )}
    </section>
  );
}
