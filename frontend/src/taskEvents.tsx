import { createContext, useCallback, useContext, useEffect, useMemo, useRef, type ReactNode } from "react";
import type { Task, TaskLog } from "./types";

export type TaskEvent =
  | { type: "task_created"; task: Task }
  | { type: "task_updated"; task: Task }
  | { type: "task_deleted"; task_id: string; project_id: string }
  | { type: "log_added"; task_id: string; log: TaskLog };

interface TaskEventsContextValue {
  subscribe: (handler: (event: TaskEvent) => void) => () => void;
  subscribeReconnect: (handler: () => void) => () => void;
}

const TaskEventsContext = createContext<TaskEventsContextValue | null>(null);

interface TaskEventsProviderProps {
  apiKey: string | null;
  children: ReactNode;
}

export function TaskEventsProvider({ apiKey, children }: TaskEventsProviderProps) {
  const eventHandlers = useRef(new Set<(event: TaskEvent) => void>());
  const reconnectHandlers = useRef(new Set<() => void>());

  const subscribe = useCallback((handler: (event: TaskEvent) => void) => {
    eventHandlers.current.add(handler);
    return () => eventHandlers.current.delete(handler);
  }, []);

  const subscribeReconnect = useCallback((handler: () => void) => {
    reconnectHandlers.current.add(handler);
    return () => reconnectHandlers.current.delete(handler);
  }, []);

  const contextValue = useMemo(() => ({ subscribe, subscribeReconnect }), [subscribe, subscribeReconnect]);

  useEffect(() => {
    if (!apiKey) return;

    let socket: WebSocket | null = null;
    let reconnectTimer: number | undefined;
    let disposed = false;
    let connectedOnce = false;
    let backoff = 1000;

    const connect = () => {
      const protocol = window.location.protocol === "http:" ? "ws" : "wss";
      socket = new WebSocket(`${protocol}://${window.location.host}/ws?api_key=${encodeURIComponent(apiKey)}`);

      socket.onopen = () => {
        backoff = 1000;
        if (connectedOnce) {
          reconnectHandlers.current.forEach((handler) => handler());
        }
        connectedOnce = true;
      };

      socket.onmessage = (message) => {
        try {
          const event = JSON.parse(message.data) as TaskEvent;
          eventHandlers.current.forEach((handler) => handler(event));
        } catch {
          // Ignore malformed WebSocket messages.
        }
      };

      socket.onclose = () => {
        if (disposed) return;
        reconnectTimer = window.setTimeout(connect, backoff);
        backoff = Math.min(backoff * 2, 15000);
      };
    };

    connect();

    return () => {
      disposed = true;
      if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
      socket?.close();
    };
  }, [apiKey]);

  return <TaskEventsContext.Provider value={contextValue}>{children}</TaskEventsContext.Provider>;
}

function useTaskEventsContext() {
  const context = useContext(TaskEventsContext);
  if (!context) throw new Error("Task event hooks must be used under TaskEventsProvider.");
  return context;
}

export function useTaskEvents(handler: (event: TaskEvent) => void) {
  const { subscribe } = useTaskEventsContext();
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => subscribe((event) => handlerRef.current(event)), [subscribe]);
}

export function useTaskEventsReconnect(handler: () => void) {
  const { subscribeReconnect } = useTaskEventsContext();
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => subscribeReconnect(() => handlerRef.current()), [subscribeReconnect]);
}
