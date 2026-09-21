import type { MouseEvent } from "react";
import type { Task } from "../types";
import { TagBadge } from "./TagBadge";

interface TaskCardProps {
  task: Task;
  onSelect: (taskId: string, originY: number) => void;
  projectName?: string;
}

export function TaskCard({ task, onSelect, projectName }: TaskCardProps) {
  function handleClick(event: MouseEvent<HTMLButtonElement>) {
    // Pass along the card's vertical position on screen so the detail panel
    // can open from where the user actually clicked, instead of always
    // snapping into view at the very top of the viewport.
    const rect = event.currentTarget.getBoundingClientRect();
    onSelect(task.id, rect.top + rect.height / 2);
  }

  return (
    <button className="task-card" onClick={handleClick} type="button">
      {projectName && <span className="task-project">{projectName}</span>}
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
