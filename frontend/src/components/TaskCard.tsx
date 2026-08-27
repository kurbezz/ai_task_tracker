import type { Task } from "../types";
import { TagBadge } from "./TagBadge";

interface TaskCardProps {
  task: Task;
  onSelect: (taskId: string) => void;
}

export function TaskCard({ task, onSelect }: TaskCardProps) {
  return (
    <button className="task-card" onClick={() => onSelect(task.id)} type="button">
      <span className="task-card-title">{task.title}</span>
      {task.agent && <span className="task-agent">Agent: {task.agent}</span>}
      {task.tags.length > 0 && (
        <span className="task-card-tags">
          {task.tags.map((tag) => <TagBadge key={tag.id} tag={tag} />)}
        </span>
      )}
    </button>
  );
}
