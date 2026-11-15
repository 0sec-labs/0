import { describe, expect, it } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"
import { buttonVariants } from "./button"
import { Input } from "./input"
import { Textarea } from "./textarea"

describe("shared hover and focus states", () => {
  it("bordered chips go from bg-button to bg-button-hover, ghost controls use the secondary overlay", () => {
    expect(buttonVariants({ variant: "outline" })).toContain("hover:bg-[color:var(--intent-bg-hover,var(--button-hover))]")
    expect(buttonVariants({ variant: "ghost" })).toContain("hover:bg-[color:var(--intent-bg-hover,var(--secondary))]")
  })
  it("text fields draw the 1px inset accent ring on keyboard focus", () => {
    expect(renderToStaticMarkup(<Input />)).toContain("focus-visible:outline-ring-inset")
    expect(renderToStaticMarkup(<Textarea />)).toContain("focus-visible:outline-ring-inset")
  })
})
