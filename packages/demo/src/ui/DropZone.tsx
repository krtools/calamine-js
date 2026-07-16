import { useRef, useState, type ReactNode } from "react";

export function DropZone({
  onFile,
  compact,
  children,
}: {
  onFile: (f: File) => void;
  compact?: boolean;
  children: ReactNode;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);

  const accept = (files: FileList | null): void => {
    const f = files?.[0];
    if (f) onFile(f);
  };

  return (
    <div
      className={`dropzone${over ? " over" : ""}${compact ? " compact" : ""}`}
      role="button"
      tabIndex={0}
      onClick={() => input.current?.click()}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") input.current?.click();
      }}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        accept(e.dataTransfer.files);
      }}
    >
      {children}
      <input
        ref={input}
        type="file"
        accept=".xlsx"
        hidden
        onChange={(e) => {
          accept(e.currentTarget.files);
          e.currentTarget.value = "";
        }}
      />
    </div>
  );
}
