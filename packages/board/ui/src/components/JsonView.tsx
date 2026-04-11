import { useCallback, useMemo } from "react";
import {
  JsonView as LibJsonView,
  darkStyles,
} from "react-json-view-lite";
import "react-json-view-lite/dist/index.css";

interface JsonViewProps {
  data: unknown;
  maxHeight?: string;
  /** Size in bytes above which tree rendering is skipped. Default 512 KB. */
  maxRenderBytes?: number;
  /** Nodes with more than this many immediate children render collapsed. Default 50. */
  wideNodeThreshold?: number;
}

const styles = {
  ...darkStyles,
  container: `${darkStyles.container} font-mono text-xs text-board-text bg-transparent`,
  label: `${darkStyles.label} text-board-primary`,
  clickableLabel: `${darkStyles.clickableLabel} text-board-primary`,
  nullValue: `${darkStyles.nullValue} text-board-muted italic`,
  undefinedValue: `${darkStyles.undefinedValue} text-board-muted italic`,
  numberValue: `${darkStyles.numberValue} text-board-warning`,
  stringValue: `${darkStyles.stringValue} text-board-success`,
  booleanValue: `${darkStyles.booleanValue} text-board-warning`,
  otherValue: `${darkStyles.otherValue} text-board-muted`,
  punctuation: `${darkStyles.punctuation} text-board-muted`,
  expandIcon: `${darkStyles.expandIcon} text-board-muted`,
  collapseIcon: `${darkStyles.collapseIcon} text-board-muted`,
  collapsedContent: `${darkStyles.collapsedContent} text-board-muted`,
};

export function JsonView({
  data,
  maxHeight = "300px",
  maxRenderBytes = 512 * 1024,
  wideNodeThreshold = 50,
}: JsonViewProps) {
  const view = useMemo(() => measure(data), [data]);

  const shouldExpandNode = useCallback(
    (level: number, value: unknown) => {
      if (level > 0) return false;
      if (Array.isArray(value)) return value.length <= wideNodeThreshold;
      if (value && typeof value === "object")
        return Object.keys(value).length <= wideNodeThreshold;
      return true;
    },
    [wideNodeThreshold],
  );

  if (view.kind === "tree" && view.size <= maxRenderBytes) {
    return (
      <div
        className="rounded-md bg-board-bg border border-board-border p-3 overflow-auto"
        style={{ maxHeight }}
      >
        <LibJsonView
          data={view.value}
          style={styles}
          shouldExpandNode={shouldExpandNode}
        />
      </div>
    );
  }

  const isTruncated = view.kind === "tree" && view.size > maxRenderBytes * 4;
  const text = isTruncated
    ? `${view.text.slice(0, maxRenderBytes * 4)}\n\n… truncated (${formatBytes(view.size)} total)`
    : view.text;

  return (
    <div className="space-y-2">
      {view.kind === "tree" && view.size > maxRenderBytes && (
        <div className="rounded border border-board-warning/40 bg-board-warning/10 px-2 py-1 text-xs text-board-warning">
          Large payload ({formatBytes(view.size)}) — tree view disabled
        </div>
      )}
      <pre
        className="rounded-md bg-board-bg border border-board-border p-3 text-xs text-board-text overflow-auto whitespace-pre-wrap break-words"
        style={{ maxHeight }}
      >
        {text || "null"}
      </pre>
    </div>
  );
}

type Measured =
  | { kind: "tree"; value: object; text: string; size: number }
  | { kind: "raw"; text: string; size: number };

function measure(data: unknown): Measured {
  if (data == null) return { kind: "raw", text: "null", size: 4 };
  if (typeof data === "string") return { kind: "raw", text: data, size: data.length };
  if (typeof data !== "object") {
    const text = String(data);
    return { kind: "raw", text, size: text.length };
  }
  try {
    const text = JSON.stringify(data, null, 2) ?? "null";
    return { kind: "tree", value: data as object, text, size: text.length };
  } catch {
    return { kind: "raw", text: "[unserializable]", size: 16 };
  }
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
