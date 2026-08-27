import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { listAttention } from "../api";
import { TagBadge } from "../components/TagBadge";
import { STATUS_LABELS, type AttentionItem } from "../types";

const attentionTags = new Set(["NEEDS_USER_INPUT", "BLOCKED", "FAILED"]);

export function AttentionPage() {
  const [items, setItems] = useState<AttentionItem[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    listAttention().then(setItems).catch((reason: Error) => setError(reason.message)).finally(() => setLoading(false));
  }, []);

  return <section className="page attention-page">
    <div className="page-intro attention-intro"><div><p className="eyebrow">Daily triage</p><h1>Attention<br /><em>needed.</em></h1><p className="lede">Tasks that need a decision, are blocked, or had an unsuccessful run.</p></div><div className="attention-signal"><span>!</span><strong>{items.length}</strong><small>open signals</small></div></div>
    {error && <div className="error-banner" role="alert">{error}</div>}
    {loading ? <p className="loading-copy">Loading attention queue…</p> : items.length === 0 ? <div className="empty-state attention-empty"><span className="empty-mark">✓</span><p>No tasks need attention right now.</p></div> : <div className="attention-list">{items.map((item) => <Link className="attention-row" key={item.id} to={`/?project=${item.project_id}`}><div className="attention-project">{item.project_name}</div><div className="attention-task"><h2>{item.title}</h2><span>{STATUS_LABELS[item.status]}{item.agent ? ` · ${item.agent}` : ""}</span></div><div className="attention-tags">{item.tags.filter((tag) => attentionTags.has(tag.name)).map((tag) => <TagBadge key={tag.id} tag={tag} />)}</div><span className="tile-arrow">→</span></Link>)}</div>}
  </section>;
}
