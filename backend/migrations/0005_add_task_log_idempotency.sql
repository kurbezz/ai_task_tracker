ALTER TABLE task_logs ADD COLUMN idempotency_key TEXT;

CREATE UNIQUE INDEX task_logs_idempotency_key_unique
ON task_logs (idempotency_key)
WHERE idempotency_key IS NOT NULL;
