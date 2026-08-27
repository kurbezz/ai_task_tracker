import { FormEvent, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { createProject, listProjects } from "../api";
import type { Project } from "../types";

export function ProjectsPage() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

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
      {loading ? <p className="loading-copy">Loading projects…</p> : projects.length === 0 ? (
        <div className="empty-state"><span className="empty-mark">↗</span><p>No projects yet. Create one to start tracking AI work.</p></div>
      ) : (
        <div className="project-grid">
          {projects.map((project, index) => (
            <Link className="project-tile" to={`/projects/${project.id}`} key={project.id}>
              <span className="project-number">0{index + 1}</span>
              <div><h3>{project.name}</h3><p>{project.description || "No description yet."}</p></div>
              <span className="tile-arrow" aria-hidden="true">→</span>
            </Link>
          ))}
        </div>
      )}
    </section>
  );
}
