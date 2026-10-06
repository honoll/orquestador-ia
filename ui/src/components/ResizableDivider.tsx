import {
  createContext,
  useContext,
  useRef,
  type CSSProperties,
  type HTMLAttributes,
  type ReactNode,
} from "react";

type Direction = "horizontal" | "vertical";

type ResizableGroupProps = {
  direction: Direction;
  className?: string;
  children: ReactNode;
} & HTMLAttributes<HTMLDivElement>;

type ResizablePanelProps = {
  defaultSize?: number;
  minSize?: number;
  maxSize?: number;
  className?: string;
  children: ReactNode;
} & HTMLAttributes<HTMLDivElement>;

type ResizableHandleProps = {
  className?: string;
  direction?: Direction;
} & HTMLAttributes<HTMLDivElement>;

type ResizableContextValue = {
  direction: Direction;
};

const ResizableContext = createContext<ResizableContextValue | null>(null);

function cx(...classes: Array<string | undefined | false>) {
  return classes.filter(Boolean).join(" ");
}

function getPanelSize(panel: HTMLElement, groupSize: number, direction: Direction) {
  const rect = panel.getBoundingClientRect();
  const size = direction === "horizontal" ? rect.width : rect.height;
  return groupSize > 0 ? (size / groupSize) * 100 : 0;
}

function getMinSize(panel: HTMLElement) {
  return Number(panel.dataset.minSize ?? "0");
}

function getMaxSize(panel: HTMLElement) {
  const maxSize = Number(panel.dataset.maxSize ?? "100");
  return Number.isFinite(maxSize) ? maxSize : 100;
}

export function ResizableGroup({
  direction,
  className,
  children,
  ...props
}: ResizableGroupProps) {
  return (
    <ResizableContext.Provider value={{ direction }}>
      <div
        data-panel-group-direction={direction}
        className={cx(
          "group/resizable flex h-full w-full",
          direction === "vertical" && "flex-col",
          className,
        )}
        {...props}
      >
        {children}
      </div>
    </ResizableContext.Provider>
  );
}

export function ResizablePanel({
  defaultSize,
  minSize = 15,
  maxSize,
  className,
  children,
  style,
  ...props
}: ResizablePanelProps) {
  const panelStyle: CSSProperties = {
    flex: defaultSize ? `1 1 ${defaultSize}%` : "1 1 0",
    ...style,
  };

  return (
    <div
      data-resizable-panel
      data-min-size={minSize}
      data-max-size={maxSize}
      className={cx("min-h-0 min-w-0", className)}
      style={panelStyle}
      {...props}
    >
      {children}
    </div>
  );
}

export function ResizableHandle({
  className,
  direction: _direction,
  onPointerDown,
  ...props
}: ResizableHandleProps) {
  const context = useContext(ResizableContext);
  const handleRef = useRef<HTMLDivElement>(null);
  const groupDirection = context?.direction ?? _direction ?? "horizontal";

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    onPointerDown?.(event);
    if (event.defaultPrevented || event.button !== 0) return;

    const handle = handleRef.current;
    const previousPanel = handle?.previousElementSibling as HTMLElement | null;
    const nextPanel = handle?.nextElementSibling as HTMLElement | null;
    const group = handle?.parentElement as HTMLElement | null;
    if (!handle || !previousPanel || !nextPanel || !group) return;

    event.preventDefault();
    handle.setPointerCapture(event.pointerId);

    const groupRect = group.getBoundingClientRect();
    const groupSize = groupDirection === "horizontal" ? groupRect.width : groupRect.height;
    const startPointer = groupDirection === "horizontal" ? event.clientX : event.clientY;
    const previousStart = getPanelSize(previousPanel, groupSize, groupDirection);
    const nextStart = getPanelSize(nextPanel, groupSize, groupDirection);
    const totalSize = previousStart + nextStart;
    const previousMin = getMinSize(previousPanel);
    const nextMin = getMinSize(nextPanel);
    const previousMax = getMaxSize(previousPanel);
    const nextMax = getMaxSize(nextPanel);

    const handlePointerMove = (moveEvent: PointerEvent) => {
      const currentPointer = groupDirection === "horizontal" ? moveEvent.clientX : moveEvent.clientY;
      const delta = groupSize > 0 ? ((currentPointer - startPointer) / groupSize) * 100 : 0;
      const nextPrevious = Math.min(
        Math.max(previousStart + delta, previousMin, totalSize - nextMax),
        previousMax,
        totalSize - nextMin,
      );
      const nextNext = totalSize - nextPrevious;

      previousPanel.style.flex = `1 1 ${nextPrevious}%`;
      nextPanel.style.flex = `1 1 ${nextNext}%`;
    };

    const stopDragging = () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", stopDragging);
      window.removeEventListener("pointercancel", stopDragging);
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", stopDragging);
    window.addEventListener("pointercancel", stopDragging);
  };

  return (
    <div
      ref={handleRef}
      role="separator"
      aria-orientation={groupDirection}
      className={cx(
        "group/handle relative flex items-center justify-center bg-transparent transition-colors",
        "w-1 cursor-col-resize hover:bg-accent/40 active:bg-accent",
        "data-[panel-group-direction=vertical]:h-1 data-[panel-group-direction=vertical]:w-full data-[panel-group-direction=vertical]:cursor-row-resize",
        groupDirection === "vertical" && "h-1 w-full cursor-row-resize",
        className,
      )}
      onPointerDown={handlePointerDown}
      {...props}
    >
      <div className={cx("flex items-center justify-center gap-0.5", groupDirection === "vertical" && "hidden")}>
        <div className="h-3 w-0.5 rounded-full bg-text-tertiary/40" />
        <div className="h-3 w-0.5 rounded-full bg-text-tertiary/40" />
        <div className="h-3 w-0.5 rounded-full bg-text-tertiary/40" />
      </div>
      <div className={cx("hidden items-center justify-center gap-0.5", groupDirection === "vertical" && "flex")}>
        <div className="h-0.5 w-3 rounded-full bg-text-tertiary/40" />
        <div className="h-0.5 w-3 rounded-full bg-text-tertiary/40" />
        <div className="h-0.5 w-3 rounded-full bg-text-tertiary/40" />
      </div>
    </div>
  );
}
