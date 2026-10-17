import { useEffect, useState } from "react";

import { Button } from "@astryxdesign/core/Button";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { HStack } from "@astryxdesign/core/HStack";
import {
  SegmentedControl,
  SegmentedControlItem,
} from "@astryxdesign/core/SegmentedControl";
import { Selector } from "@astryxdesign/core/Selector";
import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/VStack";

import type {
  ExportFormat,
  PdfOrientation,
  PdfPageSize,
} from "../../../shared/ipc";
import type { ExportScope } from "../export";

/**
 * Export options (FR-EXP-06 through FR-EXP-16).
 *
 * Every field the IPC contract already honoured but nothing could set. Scale and
 * JPEG quality are MUST requirements, so this dialog is what makes them reachable
 * rather than a nicety: without it the app always exports at 2x and 0.92.
 */
export interface ExportOptions {
  format: ExportFormat;
  scope: ExportScope;
  scale: number;
  quality: number;
  pageSize: PdfPageSize;
  orientation: PdfOrientation;
  marginPoints: number;
  background: "transparent" | "white";
}

export const DEFAULT_EXPORT_OPTIONS: ExportOptions = {
  format: "svg",
  scope: "document",
  scale: 2,
  quality: 0.92,
  pageSize: "A4",
  orientation: "landscape",
  marginPoints: 0,
  background: "transparent",
};

const FORMAT_OPTIONS = [
  { value: "svg", label: "SVG — vector, editable" },
  { value: "png", label: "PNG — raster, transparency" },
  { value: "jpeg", label: "JPEG — raster, small file" },
  { value: "pdf", label: "PDF — vector, print" },
];

/** FR-EXP-14: scale factors, stated with the DPI each one implies at 72dpi base. */
const SCALE_OPTIONS = [
  { value: "1", label: "1x (72 dpi)" },
  { value: "2", label: "2x (144 dpi)" },
  { value: "3", label: "3x (216 dpi)" },
  { value: "4", label: "4x (288 dpi)" },
];

/** FR-EXP-16: JPEG quality, as named steps rather than a raw number. */
const QUALITY_OPTIONS = [
  { value: "0.6", label: "Low — smallest file" },
  { value: "0.75", label: "Medium" },
  { value: "0.92", label: "High" },
  { value: "1", label: "Maximum — largest file" },
];

const PAGE_SIZE_OPTIONS = [
  { value: "A3", label: "A3" },
  { value: "A4", label: "A4" },
  { value: "Letter", label: "Letter" },
  { value: "Legal", label: "Legal" },
];

/** FR-EXP-09, in points (1/72 inch) to match the print API. */
const MARGIN_OPTIONS = [
  { value: "0", label: "None" },
  { value: "12", label: "Narrow (12 pt)" },
  { value: "24", label: "Normal (24 pt)" },
  { value: "36", label: "Wide (36 pt)" },
];

interface ExportDialogProps {
  isOpen: boolean;
  onOpenChange: (isOpen: boolean) => void;
  initialFormat: ExportFormat;
  /** Disables the selection scope when nothing is selected. */
  hasSelection: boolean;
  onExport: (options: ExportOptions) => void;
}

export function ExportDialog({
  isOpen,
  onOpenChange,
  initialFormat,
  hasSelection,
  onExport,
}: ExportDialogProps) {
  const [options, setOptions] = useState<ExportOptions>(DEFAULT_EXPORT_OPTIONS);

  // Reopening the dialog should reflect whichever format button was clicked,
  // while keeping the rest of the user's previous choices.
  useEffect(() => {
    if (isOpen) setOptions((current) => ({ ...current, format: initialFormat }));
  }, [isOpen, initialFormat]);

  const patch = (changes: Partial<ExportOptions>): void => {
    setOptions((current) => ({ ...current, ...changes }));
  };

  const isRaster = options.format === "png" || options.format === "jpeg";

  return (
    <Dialog
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      width={460}
      // A form purpose stops a stray backdrop click from discarding the settings.
      purpose="form"
      padding={4}
    >
      <DialogHeader
        title="Export diagram"
        subtitle="Choose a format, then the options that apply to it."
        onOpenChange={onOpenChange}
      />

      <VStack gap={3}>
        <Selector
          label="Format"
          options={FORMAT_OPTIONS}
          value={options.format}
          onChange={(value) => patch({ format: value as ExportFormat })}
          width="100%"
        />

        <VStack gap={1}>
          <Text type="label">Scope</Text>
          <SegmentedControl
            label="Export scope"
            value={options.scope}
            onChange={(value) => patch({ scope: value as ExportScope })}
            layout="fill"
            size="sm"
          >
            <SegmentedControlItem value="document" label="Document" />
            <SegmentedControlItem
              value="selection"
              label="Selection"
              isDisabled={!hasSelection}
            />
            <SegmentedControlItem value="viewport" label="Viewport" />
          </SegmentedControl>
          {!hasSelection ? (
            <Text type="supporting" color="secondary">
              Select one or more objects to export just the selection.
            </Text>
          ) : null}
        </VStack>

        <VStack gap={1}>
          <Text type="label">Background</Text>
          <SegmentedControl
            label="Export background"
            value={options.background}
            onChange={(value) =>
              patch({ background: value as ExportOptions["background"] })
            }
            layout="fill"
            size="sm"
          >
            <SegmentedControlItem value="transparent" label="Transparent" />
            <SegmentedControlItem value="white" label="White" />
          </SegmentedControl>
        </VStack>

        {isRaster ? (
          <Selector
            label="Scale"
            description="Higher scales render more pixels. Very large drawings may hit the export size limit."
            options={SCALE_OPTIONS}
            value={String(options.scale)}
            onChange={(value) => patch({ scale: Number(value) })}
            width="100%"
          />
        ) : null}

        {options.format === "jpeg" ? (
          <Selector
            label="JPEG quality"
            description="JPEG has no transparency, so a transparent background is composited onto white."
            options={QUALITY_OPTIONS}
            value={String(options.quality)}
            onChange={(value) => patch({ quality: Number(value) })}
            width="100%"
          />
        ) : null}

        {options.format === "pdf" ? (
          <>
            <Selector
              label="Page size"
              options={PAGE_SIZE_OPTIONS}
              value={options.pageSize}
              onChange={(value) => patch({ pageSize: value as PdfPageSize })}
              width="100%"
            />
            <VStack gap={1}>
              <Text type="label">Orientation</Text>
              <SegmentedControl
                label="Page orientation"
                value={options.orientation}
                onChange={(value) =>
                  patch({ orientation: value as PdfOrientation })
                }
                layout="fill"
                size="sm"
              >
                <SegmentedControlItem value="portrait" label="Portrait" />
                <SegmentedControlItem value="landscape" label="Landscape" />
              </SegmentedControl>
            </VStack>
            <Selector
              label="Margin"
              options={MARGIN_OPTIONS}
              value={String(options.marginPoints)}
              onChange={(value) => patch({ marginPoints: Number(value) })}
              width="100%"
            />
          </>
        ) : null}
      </VStack>

      <HStack gap={2} hAlign="end">
        <Button label="Cancel" variant="ghost" onClick={() => onOpenChange(false)} />
        <Button
          label={`Export ${options.format.toUpperCase()}`}
          variant="primary"
          onClick={() => {
            onOpenChange(false);
            onExport(options);
          }}
        />
      </HStack>
    </Dialog>
  );
}
