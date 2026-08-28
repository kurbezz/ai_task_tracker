export type Status =
  | "TO_DO"
  | "TO_AGENT"
  | "TO_REVIEW"
  | "TO_DEPLOY"
  | "DONE";

export const STATUS_ORDER: Status[] = [
  "TO_DO",
  "TO_AGENT",
  "TO_REVIEW",
  "TO_DEPLOY",
  "DONE",
];

export const STATUS_LABELS: Record<Status, string> = {
  TO_DO: "To do",
  TO_AGENT: "To agent",
  TO_REVIEW: "To review",
  TO_DEPLOY: "To deploy",
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
  source_url: string | null;
  pr_url: string | null;
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

export interface TimeEntry {
  id: string;
  task_id: string;
  task_title: string;
  minutes: number;
}

export interface TimeSyncStatus {
  synced_at: string | null;
  is_synced: boolean;
}
