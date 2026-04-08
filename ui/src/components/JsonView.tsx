interface JsonViewProps {
  data: unknown;
  maxHeight?: string;
}

export function JsonView({ data, maxHeight = "300px" }: JsonViewProps) {
  const text = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  return (
    <pre
      className="rounded-md bg-board-bg border border-board-border p-3 text-xs text-board-text overflow-auto"
      style={{ maxHeight }}
    >
      {text ?? "null"}
    </pre>
  );
}
