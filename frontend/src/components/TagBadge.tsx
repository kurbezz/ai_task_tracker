import type { Tag } from "../types";

const attentionSymbols: Record<string, string> = {
  NEEDS_USER_INPUT: "?",
  BLOCKED: "!",
  FAILED: "×",
};

export function TagBadge({ tag }: { tag: Tag }) {
  const attentionClass =
    tag.name === "NEEDS_USER_INPUT"
      ? "tag--needs-input"
      : tag.name === "BLOCKED"
        ? "tag--blocked"
        : tag.name === "FAILED"
          ? "tag--failed"
          : tag.is_system
            ? "tag--system"
            : "tag--custom";
  const symbol = attentionSymbols[tag.name];

  return (
    <span className={`tag ${attentionClass}`} title={tag.is_system ? "System tag" : "Custom tag"}>
      {symbol && <span className="tag-symbol" aria-hidden="true">{symbol}</span>}
      {tag.name.replace(/_/g, " ")}
    </span>
  );
}
