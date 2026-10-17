import { useEffect, useRef, useState } from "react";

import { TextArea } from "@astryxdesign/core/TextArea";

import type { DiagramObject, Viewport } from "../../document/model";
import { worldToScreen } from "../geometry";

interface TextEditorOverlayProps {
  object: DiagramObject;
  viewport: Viewport;
  onCommit: (value: string) => void;
  onCancel: () => void;
}

/**
 * Inline label editor (FR-TEXT-02), rendered as an HTML overlay rather than
 * inside the SVG.
 *
 * FR-TEXT-04 anticipates exactly this. Canvas-native text editing is where
 * diagram editors usually fall down: caret placement, IME composition, selection
 * handles, undo granularity and screen-reader support all have to be rebuilt, and
 * usually badly. A real `<textarea>` provides all of it, and Astryx's TextArea
 * keeps the visual language consistent while doing so.
 *
 * Positioning goes through `containerStyle` because TextArea exposes no root
 * `className` or `style` — only container and control variants. That happens to
 * be the right constraint: it means no wrapper element is needed, so the "no raw
 * div for layout" rule in AGENTS.md stays intact.
 */
export function TextEditorOverlay({
  object,
  viewport,
  onCommit,
  onCancel,
}: TextEditorOverlayProps) {
  const [draft, setDraft] = useState(object.content?.value ?? "");
  const areaRef = useRef<HTMLTextAreaElement>(null);

  /**
   * Escape cancels, and cancelling unmounts this component — but unmounting a
   * focused textarea fires `blur` first. Without this flag the cancel would be
   * immediately followed by a commit of the very draft the user just rejected.
   */
  const cancelled = useRef(false);

  useEffect(() => {
    const node = areaRef.current;
    if (!node) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      // The canvas binds its own window-level key handler; stopping propagation
      // here keeps Escape from also clearing the selection behind the overlay.
      event.stopPropagation();
      cancelled.current = true;
      onCancel();
    };

    node.addEventListener("keydown", onKeyDown);
    return () => node.removeEventListener("keydown", onKeyDown);
  }, [onCancel]);

  const origin = worldToScreen(
    { x: object.transform.x, y: object.transform.y },
    viewport,
  );
  const width = Math.max(object.transform.width * viewport.zoom, 160);
  // Font size is document data (a number in the .astrx model), not UI chrome, so
  // it is scaled in pixels rather than pulled from a spacing token.
  const fontSize = (object.style.text?.fontSize ?? 14) * viewport.zoom;
  const rows = Math.max(1, Math.round((object.transform.height * viewport.zoom) / (fontSize * 1.4)));

  return (
    <TextArea
      ref={areaRef}
      label={`Edit the label for ${object.name ?? "this object"}`}
      isLabelHidden
      value={draft}
      hasAutoFocus
      // An offline app should not be reaching for OS spelling dictionaries.
      hasSpellCheck={false}
      rows={rows}
      width={width}
      size="sm"
      placeholder="Label"
      onChange={setDraft}
      onBlur={() => {
        if (cancelled.current) return;
        onCommit(draft);
      }}
      containerStyle={{
        position: "absolute",
        left: origin.x,
        top: origin.y,
        zIndex: 10,
      }}
      controlStyle={{ fontSize }}
    />
  );
}
