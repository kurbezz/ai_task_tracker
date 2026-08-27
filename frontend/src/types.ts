export type Status =
  | "TODO"
  | "IN_PLANNING"
  | "READY_TO_IMPLEMENT"
  | "IN_WORK"
  | "WAIT_REVIEW"
  | "READY_TO_DEPLOY"
  | "DONE";

export const STATUS_ORDER: Status[] = [
  "TODO",
  "IN_PLANNING",
  "READY_TO_IMPLEMENT",
  "IN_WORK",
  "WAIT_REVIEW",
  "READY_TO_DEPLOY",
  "DONE",
];

export const STATUS_LABELS: Record<Status, string> = {
  TODO: "To do",
  IN_PLANNING: "Planning",
  READY_TO_IMPLEMENT: "Ready to build",
  IN_WORK: "In work",
  WAIT_REVIEW: "Review",
  READY_TO_DEPLOY: "Ready to deploy",
  DONE: "Done",
};

export interface Project {
  id: string;
  name: string;
  description: string | null;
  created_at: string;
}

export interface Tag {
  id: string;
  name: string;
  is_system: boolean;
}

export interface Task {
  id: string;
  project_id: string;
  title: string;
  description: string | null;
  status: Status;
  agent: string | null;
  result_summary: string | null;
  created_at: string;
  updated_at: string;
  tags: Tag[];
}

export interface TaskLog {
  id: string;
  task_id: string;
  author: string;
  message: string;
  created_at: string;
}

export interface AttentionItem extends Task {
  project_name: string;
}
