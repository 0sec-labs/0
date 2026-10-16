import { Slider as SliderPrimitive, type SliderRootProps } from "@cloudflare/kumo/primitives/slider";
import { cn } from "@/lib/utils";

type SliderProps = Omit<SliderRootProps<number>, "className" | "orientation"> & {
  className?: string;
  label: string;
  valueText?: (value: number) => string;
};

/** Shared scalar slider with custom visuals and Base UI keyboard/drag semantics. */
export function Slider({ className, label, valueText, step = 1, largeStep = step, ...props }: SliderProps) {
  return <SliderPrimitive.Root<number> {...props} step={step} largeStep={largeStep}
    orientation="horizontal" className={cn("w-full px-2 data-disabled:opacity-50", className)}>
    <SliderPrimitive.Control className="relative flex h-8 w-full touch-none select-none items-center cursor-pointer data-disabled:cursor-not-allowed">
      <SliderPrimitive.Track className="relative h-1 w-full rounded-full bg-muted-foreground/25">
        <SliderPrimitive.Indicator className="h-full rounded-full bg-primary" />
        <SliderPrimitive.Thumb getAriaLabel={() => label} getAriaValueText={valueText ? (_formatted, value) => valueText(value) : undefined}
          className="size-4 rounded-full bg-white shadow-sm outline-none transition-[box-shadow,scale] duration-150 ease-out motion-reduce:transition-none data-dragging:scale-110 hover:shadow-md has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-primary/50 has-[:focus-visible]:ring-offset-2 has-[:focus-visible]:ring-offset-popover" />
      </SliderPrimitive.Track>
    </SliderPrimitive.Control>
  </SliderPrimitive.Root>;
}
