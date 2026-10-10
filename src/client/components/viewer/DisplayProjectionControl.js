"use client";

import { Check } from "lucide-react";
import {
  CAMERA_PROJECTION,
  normalizeCameraProjection
} from "cadjs/lib/perspective";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from "../ui/dropdown-menu";
import {
  OrthographicProjectionIcon,
  PerspectiveProjectionIcon
} from "./ProjectionModeIcons";
import {
  DISPLAY_MODE_OPTIONS,
  displayModeOptionForValue
} from "./DisplayModeOptions";

const PROJECTION_MODE_OPTIONS = Object.freeze([
  Object.freeze({
    value: CAMERA_PROJECTION.ORTHOGRAPHIC,
    label: "Orthographic projection",
    title: "Switch to orthographic projection",
    Icon: OrthographicProjectionIcon
  }),
  Object.freeze({
    value: CAMERA_PROJECTION.PERSPECTIVE,
    label: "Perspective projection",
    title: "Switch to perspective projection",
    Icon: PerspectiveProjectionIcon
  })
]);

export function projectionOptionForValue(value) {
  const normalizedProjection = normalizeCameraProjection(value);
  return PROJECTION_MODE_OPTIONS.find((option) => option.value === normalizedProjection) || PROJECTION_MODE_OPTIONS[0];
}

export function projectionMenuLabel(option) {
  return String(option?.label || "").replace(/\s+projection$/i, "") || "Perspective";
}

export function DisplayProjectionControl({
  displayMode,
  onDisplayModeChange,
  projection,
  onProjectionChange,
  open = false,
  onOpenChange,
  triggerClassName,
  iconClassName = "size-3",
  contentAlign = "start",
  contentSide = "bottom",
  contentSideOffset = 6
}) {
  const showDisplayModeSection = typeof onDisplayModeChange === "function";
  const showProjectionSection = typeof onProjectionChange === "function";
  const selectedOption = displayModeOptionForValue(displayMode);
  const selectedProjectionOption = projectionOptionForValue(projection);
  const SelectedProjectionIcon = selectedProjectionOption.Icon || PerspectiveProjectionIcon;
  const label = `Display and projection: ${selectedOption?.label || "Solid"}, ${projectionMenuLabel(selectedProjectionOption)}`;
  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={label}
          className={triggerClassName}
          onPointerDown={(event) => {
            event.stopPropagation();
          }}
        >
          <SelectedProjectionIcon className={iconClassName} strokeWidth={2} aria-hidden="true" />
          <span className="sr-only">{label}</span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align={contentAlign} side={contentSide} sideOffset={contentSideOffset} className="w-44">
        {showProjectionSection ? (
          <>
            <DropdownMenuLabel className="px-2 py-1.5 text-xs text-muted-foreground">
              Projection
            </DropdownMenuLabel>
            {PROJECTION_MODE_OPTIONS.map((option) => {
              const Icon = option.Icon;
              const selected = selectedProjectionOption.value === option.value;
              return (
                <DropdownMenuItem
                  key={option.value}
                  className="text-xs"
                  onSelect={() => {
                    onProjectionChange?.(option.value);
                  }}
                >
                  <Icon className="size-3 text-muted-foreground" strokeWidth={2} aria-hidden="true" />
                  {projectionMenuLabel(option)}
                  {selected ? (
                    <Check className="ml-auto size-3.5 text-popover-foreground" strokeWidth={2} aria-hidden="true" />
                  ) : (
                    <span className="ml-auto size-3.5" aria-hidden="true" />
                  )}
                </DropdownMenuItem>
              );
            })}
          </>
        ) : null}
        {showDisplayModeSection && showProjectionSection ? <DropdownMenuSeparator /> : null}
        {showDisplayModeSection ? (
          <>
            <DropdownMenuLabel className="px-2 py-1.5 text-xs text-muted-foreground">
              Display
            </DropdownMenuLabel>
            {DISPLAY_MODE_OPTIONS.map((option) => {
              const selected = selectedOption.value === option.value;
              return (
                <DropdownMenuItem
                  key={option.value}
                  className="text-xs"
                  onSelect={() => {
                    onDisplayModeChange?.(option.value);
                  }}
                >
                  {option.label}
                  {selected ? (
                    <Check className="ml-auto size-3.5 text-popover-foreground" strokeWidth={2} aria-hidden="true" />
                  ) : (
                    <span className="ml-auto size-3.5" aria-hidden="true" />
                  )}
                </DropdownMenuItem>
              );
            })}
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
